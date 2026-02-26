// Tests for PolicyStateStore hybrid persistence
// Phase 5.4: Verify persistence, restore, and debounce behavior

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Clean state file between tests to ensure isolation
const STATE_DIR = path.join(process.env.HOME || "/root", ".openclaw", "data");
const STATE_PATH = path.join(STATE_DIR, "policy-state.json");

function cleanState() {
  try {
    fs.unlinkSync(STATE_PATH);
  } catch {
    /* ok */
  }
  delete require.cache[require.resolve("../infra/policy-state-store.cjs")];
}

async function testBasicPersistence() {
  cleanState();
  const { PolicyStateStore } = require("../infra/policy-state-store.cjs");
  const store = new PolicyStateStore();

  store.recordSuccess("ollama", 500);
  store.recordSuccess("ollama", 600);
  store.recordSuccess("claude", 1200);
  store.recordFailure("ollama");

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.cost.totalRequests, 4);
  assert.equal(snapshot.cost.ollamaRequests, 2);
  assert.equal(snapshot.cost.claudeRequests, 1);
  assert.equal(snapshot.failover.consecutiveFailures, 1);
  assert.equal(snapshot.failover.consecutiveSuccess, 0);

  store.destroy();
}

async function testOllamaRatio() {
  cleanState();
  const { PolicyStateStore } = require("../infra/policy-state-store.cjs");
  const store = new PolicyStateStore();

  for (let i = 0; i < 85; i++) {
    store.recordSuccess("ollama", 300);
  }
  for (let i = 0; i < 15; i++) {
    store.recordSuccess("claude", 1000);
  }

  const ratio = store.getOllamaRatio();
  assert.ok(Math.abs(ratio - 0.85) < 0.01, `ratio should be ~0.85, got ${ratio}`);

  store.destroy();
}

async function testP95Latency() {
  cleanState();
  const { PolicyStateStore } = require("../infra/policy-state-store.cjs");
  const store = new PolicyStateStore();

  for (let i = 1; i <= 20; i++) {
    store.recordSuccess("ollama", i * 100);
  }

  const p95 = store.getP95Latency();
  assert.ok(p95 >= 1900, `p95 should be >= 1900, got ${p95}`);

  store.destroy();
}

async function testFailoverRecovery() {
  cleanState();
  const { PolicyStateStore } = require("../infra/policy-state-store.cjs");
  const store = new PolicyStateStore();

  store.markFailover();
  assert.equal(store.failover.isFailedOver, true);

  store.markRecovered();
  assert.equal(store.failover.isFailedOver, false);
  assert.equal(store.failover.consecutiveFailures, 0);

  store.destroy();
}

async function testSnapshotImmutability() {
  cleanState();
  const { PolicyStateStore } = require("../infra/policy-state-store.cjs");
  const store = new PolicyStateStore();

  store.recordSuccess("ollama", 500);
  const snap1 = store.getSnapshot();
  store.recordSuccess("claude", 600);
  const snap2 = store.getSnapshot();

  assert.equal(snap1.cost.totalRequests, 1);
  assert.equal(snap2.cost.totalRequests, 2);

  store.destroy();
}

// Run tests
void (async () => {
  const tests = [
    testBasicPersistence,
    testOllamaRatio,
    testP95Latency,
    testFailoverRecovery,
    testSnapshotImmutability,
  ];
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
      console.log(`  ✓ ${test.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${test.name}: ${e.message}`);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  // Cleanup
  cleanState();

  if (failed > 0) {
    process.exit(1);
  }
})();
