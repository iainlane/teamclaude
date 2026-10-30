import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
import { spawnServer } from '../test-helpers/spawn-server.js';

const OPUS = 'claude-opus-5';
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + 3600_000, ...extra });

function fleet({ allowed = true, weekly = 1, apiPriority = 100, ...accountOptions } = {}) {
  const am = new AccountManager([
    oauth('subscription', { priority: 0, allowExtraUsage: allowed, ...accountOptions }),
    { name: 'api', type: 'apikey', apiKey: 'api-key', priority: apiPriority },
  ], 0.98);
  Object.assign(am.accounts[0].quota, { unified7d: weekly, spend: { enabled: true, usedMinor: 0, currency: 'GBP', exponent: 2 } });
  am._nextProbeAt = Date.now() + 60_000;
  am.currentIndex = 1;
  return am;
}

for (const [label, options, expected, billing] of [
  ['explicit preference uses remaining included quota before API', { preferExtraUsage: true, weekly: 0.98 }, 'subscription', false],
  ['explicit preference uses credits before API', { preferExtraUsage: true }, 'subscription', true],
  ['a truthy preference does not opt in', { preferExtraUsage: 'true' }, 'api', false],
  ['preference without credit permission', { allowed: false, preferExtraUsage: true }, 'api', false],
  ['explicit API priority ahead of remaining included quota', { preferExtraUsage: true, weekly: 0.98, apiPriority: -1 }, 'api', false],
  ['explicit API priority ahead of credits', { preferExtraUsage: true, apiPriority: -1 }, 'api', false],
]) {
  test(`extra-usage priority: ${label}`, () => {
    const am = fleet(options);
    const picked = am.getActiveAccount(null, OPUS);
    const status = am.getStatus();
    assert.deepEqual({ selected: picked?.name, current: status.currentAccount, billing: status.accounts[0].onExtraUsage },
      { selected: expected, current: expected, billing });
  });
}

for (const [label, change] of [
  ['cordoned', a => { a.cordoned = true; }],
  ['disabled', a => { a.disabled = true; }],
  ['usage cap', a => { a.maxUsage = 1; }],
  ['spend cap', a => { a.maxSpend = 1; a.quota.spend.usedMinor = 100; }],
  ['upstream credits disabled', a => { a.quota.spend.enabled = false; }],
  ['billing cooldown', a => { a.billingRejectedUntil = Date.now() + 60_000; }],
  ['entitlement cooldown', a => { a.entitlementDeniedUntil = Date.now() + 60_000; }],
  ['rate limit', a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; }],
]) {
  test(`extra usage before API respects ${label}`, () => {
    const am = fleet({ preferExtraUsage: true });
    change(am.accounts[0]);
    assert.equal(am.getActiveAccount(null, OPUS)?.name, 'api');
  });
}

test('available included subscription quota is used before credits', () => {
  const am = fleet({ preferExtraUsage: true });
  am.addAccount(oauth('included', { priority: 10 }));
  am.accounts[2].quota.unified7d = 0.2;
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'included');
});

for (const [mode, setting] of [['even', true], ['adaptive', 'adaptive'], ['load', 'load']]) {
  test(`${mode} distribution preserves API affinity with the preference enabled`, () => {
    const am = fleet({ preferExtraUsage: true });
    am.setDistributeSessions(setting);
    am.recordSession('conversation', 1, OPUS);
    const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
    assert.deepEqual({ selected: picked?.name, pinned: am.sessionTracker.pinnedAccount('conversation', 'unified7d'), paid: am.getStatus().accounts[0].onExtraUsage },
      { selected: 'api', pinned: 1, paid: false });
  });

  for (const weekly of [0.98, 1]) {
    test(`${mode} distribution preserves preferred subscription affinity at ${weekly * 100}% usage`, () => {
      const am = fleet({ preferExtraUsage: true, weekly });
      am.addAccount(oauth('subscription-2', { allowExtraUsage: true, preferExtraUsage: true }));
      Object.assign(am.accounts[2].quota, { unified7d: weekly, spend: { enabled: true } });
      am.setDistributeSessions(setting);
      const selected = [];
      for (const sessionId of ['first', 'second']) {
        const turns = [];
        for (let turn = 0; turn < 2; turn++) {
          const picked = am.getActiveAccount(null, OPUS, null, sessionId);
          turns.push(picked?.name ?? null);
          if (picked) am.recordSession(sessionId, picked.index, OPUS);
        }
        selected.push(turns);
      }
      assert.deepEqual(selected, [['subscription', 'subscription'], ['subscription-2', 'subscription-2']]);
    });
  }
}

test('an exclusive model route still restricts extra usage', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setRoutes([{ name: 'opus', match: ['claude-opus-*'], accounts: ['api'] }]);
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'api');
});

test('an eligible route pin takes precedence over automatic extra usage', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setRoutes([{ name: 'opus', match: ['claude-opus-*'] }]);
  am.setRoutePin('opus', 1);
  am.setDistributeSessions(true);
  am.recordSession('conversation', 0, OPUS);

  const preview = am.previewRouteIndex(OPUS);
  const picked = am.getActiveAccount(null, OPUS, null, 'conversation');
  assert.deepEqual({ preview, selected: picked?.name, paid: am.getStatus().accounts[0].onExtraUsage },
    { preview: 1, selected: 'api', paid: false });

  am.accounts[1].disabled = true;
  assert.equal(am.getActiveAccount(null, OPUS)?.name, 'subscription');
});

for (const weekly of [0.98, 1]) {
  for (const disabled of [false, true]) {
    test(`a route pin overrides a manual fallback only while eligible (${weekly * 100}% usage, disabled=${disabled})`, () => {
      const am = new AccountManager([
        oauth('s1', { allowExtraUsage: true, preferExtraUsage: true }),
        oauth('s2', { allowExtraUsage: true, preferExtraUsage: true }),
        { name: 'pinned', type: 'apikey', apiKey: 'api-key', priority: 100, disabled },
      ], 0.98);
      am._nextProbeAt = Date.now() + 60_000;
      for (const account of am.accounts.slice(0, 2)) Object.assign(account.quota, { unified7d: weekly, spend: { enabled: true } });
      am.setRoutes([{ name: 'opus', match: ['claude-opus-*'] }]);
      am.setRoutePin('opus', 2);
      am.setCurrentAccount(1);
      const eligibility = am.eligibility(1);
      const preview = am.previewRouteIndex(OPUS);
      const selected = am.getActiveAccount(null, OPUS)?.name;
      assert.deepEqual({ eligibility, preview, selected },
        { eligibility: { eligible: true }, preview: disabled ? 1 : 2, selected: disabled ? 's2' : 'pinned' });
    });
  }
}

test('the provider partition still restricts extra usage', () => {
  const am = fleet({ preferExtraUsage: true });
  am.addAccount(oauth('codex', { provider: 'codex' }));
  assert.equal(am.getActiveAccount(null, 'gpt-5', null, null, 'codex')?.name, 'codex');
});

test('an explicit API switch remains eligible and serves requests with the preference enabled', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setCurrentAccount(0);
  const switched = am.setCurrentAccount(1);
  const eligibility = am.eligibility(1);
  const selected = [am.getActiveAccount(null, OPUS)?.name, am.getActiveAccount(null, OPUS)?.name];
  const status = am.getStatus();
  assert.deepEqual({ switched, eligibility, selected, current: status.currentAccount, paid: status.accounts[0].onExtraUsage },
    { switched: true, eligibility: { eligible: true }, selected: ['api', 'api'], current: 'api', paid: false });
});

test('automatic cursor movements clear an earlier manual API choice', () => {
  const am = fleet({ preferExtraUsage: true });
  am.setCurrentAccount(1);
  const selected = [am.getActiveAccount(null, OPUS)?.name];
  am.accounts[1].disabled = true;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  am.accounts[1].disabled = false;
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  selected.push(am.getActiveAccount(null, OPUS)?.name);
  assert.deepEqual(selected, ['api', 'subscription', 'api', 'subscription']);
});

test('reloading extra-usage permission and preference applies them independently', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(req.headers.authorization || req.headers['x-api-key']);
    res.writeHead(200, { 'content-type': 'application/json',
      ...(req.headers.authorization ? { 'anthropic-ratelimit-unified-7d-utilization': '1' } : {}),
    });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let running;
  try {
    running = await spawnServer({ config: () => ({
      proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamProxy: false,
      quotaProbeSeconds: 0,
      accounts: [oauth('subscription', { allowExtraUsage: true }), { name: 'api', type: 'apikey', apiKey: 'api-key', priority: 100 }],
    }) });
    const post = async path => {
      const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [] }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    await post('/v1/messages');
    await post('/v1/messages');
    const config = JSON.parse(await readFile(running.configPath, 'utf8'));
    delete config.accounts[0].allowExtraUsage;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    config.accounts[0].allowExtraUsage = true;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    config.accounts[0].preferExtraUsage = true;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    delete config.accounts[0].preferExtraUsage;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/v1/messages');
    assert.deepEqual(seen, ['Bearer t-subscription', 'api-key', 'api-key', 'api-key', 'Bearer t-subscription', 'api-key'], running.output());
  } finally {
    await running?.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
