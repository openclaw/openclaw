import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
let PluginRuntimeCloseRetainedError: typeof import("../../../plugins/runtime-close-error.js").PluginRuntimeCloseRetainedError;
let scheduler: typeof import("./swarm-scheduler.js");
let enqueueSwarmRun: typeof import("./swarm-scheduler.lifecycle.test-support.js").enqueueSwarmRun;

// queueMicrotask-driven starts need real microtask turns; fake timers'
// runAllTicks only drains nextTick, so flush the microtask queue explicitly.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

function holdRun(runId: string) {
  const hold = scheduler.holdQueuedSwarmRun(runId);
  assert(hold);
  return hold;
}

function makeQueue(groupId = "group", maxConcurrent = 1) {
  const started: string[] = [];
  type Reserve = Parameters<typeof scheduler.reserveSwarmRun>[0];
  type Enqueue = Parameters<typeof enqueueSwarmRun>[0];
  const reserve = (runId: string, overrides: Partial<Reserve> = {}) =>
    scheduler.reserveSwarmRun({ groupId, runId, maxConcurrent, activeRunIds: [], ...overrides });
  const launch = (runId: string) => ({
    groupId,
    runId,
    start: async () => {
      started.push(runId);
    },
    onStartFailure: () => true,
  });
  const activate = (runId: string) => scheduler.activateSwarmRun(launch(runId));
  const enqueue = (runId: string, overrides: Partial<Enqueue> = {}) =>
    enqueueSwarmRun({ maxConcurrent, activeRunIds: [], ...launch(runId), ...overrides });
  const watchCapacity = (runId: string) => {
    const owner = {};
    const waits: boolean[] = [];
    scheduler.bindSwarmRunReservation(runId, owner, () => {
      waits.push(scheduler.isSwarmRunWaitingForCapacity(runId, owner));
    });
    return { owner, waits };
  };
  return { started, reserve, activate, enqueue, watchCapacity };
}

describe("swarm scheduler", () => {
  beforeEach(async () => {
    vi.resetModules();
    scheduler = await import("./swarm-scheduler.js");
    ({ enqueueSwarmRun } = await import("./swarm-scheduler.lifecycle.test-support.js"));
    ({ PluginRuntimeCloseRetainedError } = await import("../../../plugins/runtime-close-error.js"));
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(async () => {
    try {
      await scheduler.closeSwarmScheduler();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves admission order across early preparation and stale active snapshots", async () => {
    const { started, reserve, activate } = makeQueue();
    const revision = scheduler.readSwarmReservationRevision();
    expect(reserve("one")).toBe(true);
    expect(reserve("two", { activeRunIds: ["one"] })).toBe(true);
    expect(scheduler.readSwarmReservationRevision()).toBe(revision);
    const owner = {};
    scheduler.bindSwarmRunReservation("two", owner);
    expect(scheduler.readSwarmReservationRevision()).toBe(revision + 1);
    scheduler.bindSwarmRunReservation("two", {});
    expect(scheduler.isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    activate("two");
    await Promise.resolve();
    expect(started).toEqual([]);
    expect(scheduler.isSwarmRunWaitingForCapacity("two", owner)).toBe(false);

    activate("one");
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    expect(scheduler.isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    expect(scheduler.isSwarmRunWaitingForCapacity("two", {})).toBe(false);
    expect(scheduler.releaseSwarmRun("one")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
    expect(scheduler.readSwarmReservationRevision()).toBe(revision + 1);
    expect(scheduler.releaseSwarmRun("two")).toBe(true);
    expect(scheduler.readSwarmReservationRevision()).toBe(revision + 2);
  });

  it("skips cancelled work without letting its stale hold withdraw a reused id", async () => {
    const { started, enqueue, watchCapacity } = makeQueue();
    enqueue("one");
    enqueue("two");
    enqueue("three");
    const { owner, waits } = watchCapacity("two");
    const revision = scheduler.readSwarmReservationRevision();
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    const hold = holdRun("two");
    expect(scheduler.isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    await hold.release();
    expect(scheduler.isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    const removal = holdRun("two");
    try {
      expect(scheduler.readSwarmReservationRevision()).toBe(revision);
      expect(removal.withdraw()).toBe(true);
      expect(scheduler.readSwarmReservationRevision()).toBe(revision + 1);
      expect(waits).toEqual([true, false, true, false]);
      expect(scheduler.isSwarmRunActive("two")).toBe(false);
      enqueue("two", {
        start: async () => {
          started.push("replacement");
        },
      });
      expect(removal.withdraw()).toBe(false);
      expect(removal.bindPreparation({ onRemoved: Promise.resolve(undefined) })).toBe(false);
      await removal.release();
      scheduler.releaseSwarmRun("one");
      await vi.waitFor(() => expect(started).toEqual(["one", "three"]));
      scheduler.releaseSwarmRun("three");
      await vi.waitFor(() => expect(started).toEqual(["one", "three", "replacement"]));
    } finally {
      await removal.release();
    }
    expect(removal.withdraw()).toBe(false);
    expect(scheduler.releaseSwarmRun("two")).toBe(true);
    expect(scheduler.readSwarmReservationRevision()).toBe(revision + 1);
  });

  it("does not certify an unactivated reservation without a preparation owner", async () => {
    makeQueue("unprepared").reserve("child");
    const released = holdRun("child");
    await released.release();
    expect(released.bindPreparation({ onRemoved: Promise.resolve(undefined) })).toBe(false);
    const hold = holdRun("child");
    expect(hold.withdraw()).toBe(true);
    expect(await hold.settleCancellation()).toBe(false);
    await hold.release();
  });

  it.each(["success", "failure", "shutdown"] as const)(
    "joins owned preactivation cleanup without certifying %s incorrectly",
    async (mode) => {
      const owner = {};
      const ready = createDeferred<Parameters<typeof scheduler.activateSwarmRun>[0]["onRemoved"]>();
      const cleanup = createEnteredGate();
      const failure = new Error("preparation cleanup failed");
      makeQueue("prepared").reserve("child");
      const producer = holdRun("child");
      expect(producer.bindPreparation({ onRemoved: ready.promise, lifecycleOwner: owner })).toBe(
        true,
      );
      const cancellation = holdRun("child");
      expect(cancellation.withdraw()).toBe(true);
      const settled = vi.fn();
      const settlement = cancellation.settleCancellation().then(settled, settled);
      ready.resolve(async () => {
        await cleanup.wait();
        if (mode === "failure") {
          throw failure;
        }
      });
      let closing: Promise<void> | undefined;
      try {
        await cleanup.entered;
        expect(settled).not.toHaveBeenCalled();
        if (mode === "shutdown") {
          closing = scheduler.closeSwarmScheduler(owner);
        }
        cleanup.release();
        await settlement;
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          mode === "failure" ? failure : mode === "success",
        );
      } finally {
        cleanup.release();
        await Promise.all([producer.release(), cancellation.release(), closing]);
      }
      if (mode === "failure") {
        await expect(scheduler.closeSwarmScheduler(owner)).rejects.toMatchObject({
          errors: [failure],
        });
      }
    },
  );

  it("joins removed queues and released launches while preserving retained cleanup failures", async () => {
    const lifecycleOwner = {};
    const failure = new PluginRuntimeCloseRetainedError(new Error("cleanup still owns resources"));
    const cleanup = createEnteredGate();
    const failedCleanup = vi.fn(async () => {
      throw failure;
    });
    const pendingCleanup = vi.fn(cleanup.wait);
    const launchGate = createEnteredGate();
    const releasedCleanup = vi.fn(async () => undefined);
    makeQueue("released-launch").enqueue("pending-launch", {
      lifecycleOwner,
      start: launchGate.wait,
      onRemoved: releasedCleanup,
    });
    await launchGate.entered;
    expect(scheduler.releaseSwarmRun("pending-launch")).toBe(true);
    const releases: Promise<void>[] = [];
    const { enqueue } = makeQueue();
    for (const [runId, onRemoved] of [
      ["failed", failedCleanup],
      ["pending", pendingCleanup],
    ] as const) {
      enqueue(runId, {
        activeRunIds: ["capacity"],
        lifecycleOwner,
        start: async () => undefined,
        onRemoved,
      });
      const hold = holdRun(runId);
      expect(hold.withdraw()).toBe(true);
      releases.push(hold.release());
    }
    const settled = vi.fn();
    const closing = scheduler.closeSwarmScheduler(lifecycleOwner).then(settled, settled);
    try {
      await cleanup.entered;
      await flushMicrotasks();
      expect(settled).not.toHaveBeenCalled();
      expect(releasedCleanup).not.toHaveBeenCalled();
    } finally {
      cleanup.release();
      launchGate.release();
    }
    await expect(Promise.all(releases)).resolves.toEqual([undefined, undefined]);
    await closing;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ errors: [failure] }));
    await expect(scheduler.closeSwarmScheduler(lifecycleOwner)).rejects.toMatchObject({
      errors: [failure],
    });
    expect(failedCleanup).toHaveBeenCalledOnce();
    expect(pendingCleanup).toHaveBeenCalledOnce();
    expect(releasedCleanup).toHaveBeenCalledExactlyOnceWith("shutdown");
    expect(scheduler.releaseSwarmRun("capacity")).toBe(true);
  });

  it.each([true, false])(
    "holds a failed launch's slot until cleanup is durable: %s",
    async (durable) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cleanup = createEnteredGate();
      const { started, enqueue } = makeQueue();
      enqueue("broken", {
        start: async () => {
          started.push("broken");
          throw new Error("launch failed");
        },
        onStartFailure: async () => {
          await cleanup.wait();
          if (!durable) {
            throw new Error("persistence failed");
          }
          return true;
        },
      });
      enqueue("next");
      try {
        await cleanup.entered;
        expect(started).toEqual(["broken"]);
        expect(scheduler.isSwarmRunActive("broken")).toBe(true);
        cleanup.release();
        if (durable) {
          await vi.waitFor(() => expect(started).toEqual(["broken", "next"]));
        } else {
          await vi.waitFor(() => expect(warning).toHaveBeenCalled());
          expect(started).toEqual(["broken"]);
          expect(scheduler.isSwarmRunActive("broken")).toBe(true);
        }
      } finally {
        cleanup.release();
        await scheduler.closeSwarmScheduler();
        warning.mockRestore();
      }
    },
  );

  it("refreshes reduced and increased capacity while preserving queued FIFO order", async () => {
    const { started, enqueue, reserve, watchCapacity } = makeQueue("group", 2);
    enqueue("one");
    enqueue("two");
    enqueue("three");
    const { waits } = watchCapacity("three");
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));

    expect(reserve("one", { maxConcurrent: 1, activeRunIds: ["one", "two"] })).toBe(false);
    expect(scheduler.releaseSwarmRun("one")).toBe(true);
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    expect(waits).toEqual([true]);
    enqueue("four", { maxConcurrent: 3 });
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three", "four"]));
    expect(waits).toEqual([true, false]);
    expect(scheduler.releaseSwarmRun("two")).toBe(true);
  });

  it.each(["before", "during"])(
    "holds FIFO across activation %s the hold and overlapping cancellations",
    async (activation) => {
      const { started, reserve, activate, enqueue } = makeQueue();
      reserve("held");
      if (activation === "before") {
        activate("held");
      }
      const first = holdRun("held");
      const second = holdRun("held");
      if (activation === "during") {
        activate("held");
      }
      enqueue("next");
      enqueue("foreign", { groupId: "other-group" });
      try {
        await flushMicrotasks();
        expect(started).toEqual(["foreign"]);
        await Promise.all([first.release(), first.release()]);
        await flushMicrotasks();
        expect(started).toEqual(["foreign"]);
        await second.release();
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held"]);
        scheduler.releaseSwarmRun("held");
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held", "next"]);
      } finally {
        await Promise.all([first.release(), second.release()]);
      }
    },
  );
});
