import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { createSubagentRegistrySweeper } from "../agents/subagents/registry/subagent-registry-sweeper.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { GatewayScheduler } from "./gateway-scheduler.js";

const [resource] = process.argv.slice(2);
assert.ok(resource === "sweeper" || resource === "scheduler");
const context = new AsyncLocalStorage<object>();

function observeCallerTimer(run: () => void) {
  const caller = { prompt: Buffer.alloc(1024 * 1024, 1) };
  const references = [new WeakRef(caller), new WeakRef(caller.prompt)];
  let timer: WeakRef<object> | undefined;
  const hook = createHook({
    init(_id, type, _trigger, value) {
      if (type === "Timeout") {
        timer = new WeakRef(value);
      }
    },
  }).enable();
  try {
    context.run(caller, run);
  } finally {
    hook.disable();
  }
  assert.ok(timer, "The owner must create a real native timeout");
  return { references, timer };
}

function unexpected(): never {
  throw new Error("The distant retained deadline must not execute during collection");
}

function sweeperFixture() {
  const sweeper = createSubagentRegistrySweeper({
    runs: new Map(),
    resumedRuns: new Set(),
    clearPendingLifecycleError: unexpected,
    clearPendingLifecycleTimeout: unexpected,
    sweepPendingLifecycle: unexpected,
    completeSubagentRunWithRecovery: unexpected,
    getGatewayRecoveryRuntime: unexpected,
    finalizeInterruptedSubagentRun: unexpected,
    startSubagentAnnounceCleanupFlow: unexpected,
    completeCleanupBookkeeping: unexpected,
    resumeRequesterSettleWake: unexpected,
    resumePendingRequesterSettlements: unexpected,
    isCleanupOwnerCurrent: unexpected,
    isTerminalTailActive: unexpected,
    sessionEffectsHostCurrent: unexpected,
    shouldSuppressSessionEffects: unexpected,
    discardTerminalDelivery: unexpected,
    shouldEmitEndedHookForRun: unexpected,
    emitSubagentEndedHookForRun: unexpected,
    callGateway: unexpected,
    cleanupCollectorLaunchResources: unexpected,
    runContextEngineSubagentEnded: unexpected,
    notifyContextEngineSubagentEnded: unexpected,
    retireSupersededRun: unexpected,
    retireObligations: unexpected,
    getRunsForChildSession: unexpected,
    getRunsForCollectorGroup: unexpected,
    warn: unexpected,
  });
  return { ...observeCallerTimer(sweeper.start), owner: undefined, close: () => sweeper.reset() };
}

function schedulerFixture() {
  const scheduler = new GatewayScheduler();
  // Scheduled work owns this context intentionally, independently of the host wake.
  const owner = context.run({ authority: "pending-job" }, () => {
    const retained = context.getStore();
    assert.ok(retained);
    scheduler.schedule({ id: "owned", delayMs: 60_000, run: unexpected });
    return new WeakRef(retained);
  });
  const observed = observeCallerTimer(() =>
    scheduler.schedule({ id: "canceled", delayMs: 120_000, run: unexpected }).cancel(),
  );
  return { ...observed, owner, close: () => scheduler.stop() };
}

const { timer, owner, references, close } =
  resource === "sweeper" ? sweeperFixture() : schedulerFixture();
try {
  await collectForRetentionCheck(`${resource}-timer`);
  assert.ok(timer.deref(), "Collection must happen while the native timer is alive");
  assert.ok(!owner || owner.deref(), "Pending authority stays owned");
  const retained = references.map((ref) => Boolean(ref.deref()));
  assert.deepEqual(retained, [false, false]);
  process.stdout.write(JSON.stringify({ resource, collected: references.length }));
} finally {
  await close();
}
