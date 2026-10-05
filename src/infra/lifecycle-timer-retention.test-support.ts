import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { createSubagentRegistrySweeper } from "../agents/subagents/registry/subagent-registry-sweeper.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { GatewayScheduler } from "./gateway-scheduler.js";

const [resource] = process.argv.slice(2);
assert.ok(resource === "sweeper" || resource === "scheduler");
const context = new AsyncLocalStorage<object>();

class LifecycleTimerCaller {
  readonly prompt = Buffer.alloc(1024 * 1024, 1);
}

function invokeCaller(run: () => void) {
  const caller = new LifecycleTimerCaller();
  const references = [new WeakRef(caller), new WeakRef(caller.prompt)];
  context.run(caller, run);
  return references;
}

function observeTimer(run: () => void) {
  let timer: WeakRef<object> | undefined;
  const hook = createHook({
    init(_id, type, _trigger, value) {
      if (type === "Timeout") {
        timer = new WeakRef(value);
      }
    },
  });
  hook.enable();
  try {
    run();
  } finally {
    hook.disable();
  }
  assert.ok(timer, "The owner must create a real native timeout");
  return timer;
}

function unexpected(): never {
  throw new Error("The distant retained deadline must not execute during collection");
}

type TimerFixture = {
  references: WeakRef<object>[];
  timer: WeakRef<object>;
  owner?: WeakRef<object>;
  close: () => void | Promise<void>;
};

function sweeperFixture(): TimerFixture {
  const sweeper = createSubagentRegistrySweeper({
    runs: new Map(),
    resumedRuns: new Set(),
    clearPendingLifecycleError: unexpected,
    clearPendingLifecycleTimeout: unexpected,
    sweepPendingLifecycle: unexpected,
    completeSubagentRunWithRecovery: unexpected,
    getGatewayRecoveryRuntime: unexpected,
    finalizeInterruptedSubagentRun: unexpected,
    resumeRequesterSettleWake: unexpected,
    startSubagentAnnounceCleanupFlow: unexpected,
    completeCleanupBookkeeping: unexpected,
    deleteSuspendedSubagentSession: unexpected,
    isCleanupOwnerCurrent: unexpected,
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
    getRunsForChildSession: unexpected,
    getRunsForCollectorGroup: unexpected,
    warn: unexpected,
  });
  let references: WeakRef<object>[] = [];
  const timer = observeTimer(() => {
    references = invokeCaller(sweeper.start);
  });
  return { references, timer, close: () => sweeper.reset() };
}

function schedulerFixture(): TimerFixture {
  const scheduler = new GatewayScheduler();
  // Scheduled work owns this context intentionally, independently of the host wake.
  const owner = context.run({ authority: "pending-job" }, () => {
    const retained = context.getStore();
    assert.ok(retained);
    scheduler.schedule({ id: "owned", delayMs: 60_000, run: unexpected });
    return new WeakRef(retained);
  });
  let references: WeakRef<object>[] = [];
  const timer = observeTimer(() => {
    references = invokeCaller(() => {
      const canceled = scheduler.schedule({ id: "canceled", delayMs: 120_000, run: unexpected });
      canceled.cancel();
    });
  });
  return { references, timer, owner, close: () => scheduler.stop() };
}

const fixture = resource === "sweeper" ? sweeperFixture() : schedulerFixture();
try {
  await collectForRetentionCheck(`${resource}-timer`);
  assert.ok(fixture.timer.deref(), "Collection must happen while the native timer is alive");
  if (fixture.owner) {
    assert.ok(fixture.owner.deref(), "Pending authority stays owned");
  }
  assert.equal(
    fixture.references.filter((reference) => reference.deref()).length,
    0,
    `The live ${resource} timer retained an unrelated completed caller`,
  );
  process.stdout.write(JSON.stringify({ resource, collected: fixture.references.length }));
} finally {
  await fixture.close();
}
