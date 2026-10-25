import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
let PluginRuntimeCloseRetainedError: typeof import("../../../plugins/runtime-close-error.js").PluginRuntimeCloseRetainedError;
let scheduler: typeof import("./swarm-scheduler.js");

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
  type Enqueue = Parameters<typeof scheduler.enqueueSwarmRun>[0];
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
    scheduler.enqueueSwarmRun({ maxConcurrent, activeRunIds: [], ...launch(runId), ...overrides });
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
    ({ PluginRuntimeCloseRetainedError } = await import("../../../plugins/runtime-close-error.js"));
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(async () => {
    try {
      await scheduler.closeSwarmScheduler();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("preserves admission order when later preparation finishes first", async () => {
    const { started, reserve, activate } = makeQueue();
    expect(reserve("one")).toBe(true);
    expect(reserve("two")).toBe(true);
    const owner = {};
    scheduler.bindSwarmRunReservation("two", owner);
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
  });

  it("removes a cancelled queued run before the next slot opens", async () => {
    const { started, enqueue, watchCapacity } = makeQueue();
    enqueue("one");
    enqueue("two");
    enqueue("three");
    const { owner, waits } = watchCapacity("two");
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    const hold = holdRun("two");
    expect(scheduler.isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    await hold.release();
    expect(scheduler.isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    const removal = holdRun("two");
    try {
      expect(removal.withdraw()).toBe(true);
      expect(waits).toEqual([true, false, true, false]);
      scheduler.releaseSwarmRun("one");
      await vi.waitFor(() => expect(started).toEqual(["one", "three"]));
    } finally {
      await removal.release();
    }
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
      const settlement = cancellation
        .settleCancellation()
        .then(
          (qualified) => ({ qualified }),
          (error: unknown) => ({ error }),
        )
        .finally(settled);
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
        expect(await settlement).toEqual(
          mode === "failure" ? { error: failure } : { qualified: mode === "success" },
        );
        expect(settled).toHaveBeenCalledOnce();
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

  it("joins removed queues and preserves retained cleanup failures", async () => {
    const lifecycleOwner = {};
    const failure = new PluginRuntimeCloseRetainedError(new Error("cleanup still owns resources"));
    const cleanup = createEnteredGate();
    const failedCleanup = vi.fn(async () => {
      throw failure;
    });
    const pendingCleanup = vi.fn(cleanup.wait);
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
    const closing = scheduler
      .closeSwarmScheduler(lifecycleOwner)
      .catch((error: unknown) => error)
      .finally(settled);
    try {
      await cleanup.entered;
      expect(settled).not.toHaveBeenCalled();
    } finally {
      cleanup.release();
    }
    await expect(Promise.all(releases)).resolves.toEqual([undefined, undefined]);
    expect(await closing).toMatchObject({ errors: [failure] });
    await expect(scheduler.closeSwarmScheduler(lifecycleOwner)).rejects.toMatchObject({
      errors: [failure],
    });
    expect(failedCleanup).toHaveBeenCalledOnce();
    expect(pendingCleanup).toHaveBeenCalledOnce();
    expect(scheduler.releaseSwarmRun("capacity")).toBe(true);
  });

  it("joins a released reservation's pending launch before shutdown cleanup", async () => {
    const lifecycleOwner = {};
    const launchGate = createEnteredGate();
    const onRemoved = vi.fn(async () => undefined);
    makeQueue("released-launch").enqueue("pending-launch", {
      lifecycleOwner,
      start: launchGate.wait,
      onRemoved,
    });
    await launchGate.entered;
    expect(scheduler.releaseSwarmRun("pending-launch")).toBe(true);
    const closing = scheduler.closeSwarmScheduler(lifecycleOwner);
    try {
      await flushMicrotasks();
      expect(onRemoved).not.toHaveBeenCalled();
    } finally {
      launchGate.release();
    }
    await closing;
    expect(onRemoved).toHaveBeenCalledExactlyOnceWith("shutdown");
  });

  it("keeps a live reservation queued when a later snapshot reports it active", async () => {
    const { started, reserve, activate } = makeQueue();
    expect(reserve("queued")).toBe(true);
    expect(reserve("next", { activeRunIds: ["queued"] })).toBe(true);
    activate("queued");
    await vi.waitFor(() => expect(started).toEqual(["queued"]));
    activate("next");
    await flushMicrotasks();
    expect(started).toEqual(["queued"]);
    scheduler.releaseSwarmRun("queued");
    await vi.waitFor(() => expect(started).toEqual(["queued", "next"]));
  });

  it("retains a failed launch's slot when failure persistence is unavailable", async () => {
    const failure = new Error("persistence failed");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = createDeferred();
    const next = vi.fn(async () => {});
    const start = vi.fn(async () => {
      throw new Error("launch failed");
    });
    const { enqueue } = makeQueue();
    enqueue("broken", {
      start,
      onStartFailure: () => {
        failed.resolve();
        throw failure;
      },
    });
    enqueue("next", { start: next });
    try {
      await failed.promise;
      await flushMicrotasks();
      expect(start).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
      expect(scheduler.isSwarmRunActive("broken")).toBe(true);
      expect(warning).toHaveBeenCalledWith(
        "[swarm] Failed launch cleanup: Error: persistence failed",
      );
      await scheduler.closeSwarmScheduler();
    } finally {
      warning.mockRestore();
    }
  });

  it("holds the group slot until asynchronous failure cleanup finishes", async () => {
    const { started, enqueue } = makeQueue();
    const cleanup = createDeferred();
    enqueue("failed", {
      start: async () => {
        started.push("failed");
        throw new Error("launch failed");
      },
      onStartFailure: async () => {
        await cleanup.promise;
        return true;
      },
    });
    enqueue("next");

    await vi.waitFor(() => expect(started).toEqual(["failed"]));
    cleanup.resolve();
    await vi.waitFor(() => expect(started).toEqual(["failed", "next"]));
  });

  it("refreshes the lane limit before rejecting a duplicate reservation", async () => {
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
    expect(scheduler.releaseSwarmRun("two")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
    expect(waits).toEqual([true, false]);
  });

  it("fills increased capacity from the existing FIFO queue", async () => {
    const { started, enqueue } = makeQueue();
    enqueue("one");
    enqueue("two");
    enqueue("three", { maxConcurrent: 3 });

    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
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
        expect(scheduler.isSwarmRunActive("held")).toBe(false);
        await Promise.all([first.release(), first.release()]);
        await flushMicrotasks();
        expect(started).toEqual(["foreign"]);
        await second.release();
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held"]);
        expect(scheduler.isSwarmRunActive("held")).toBe(true);
        scheduler.releaseSwarmRun("held");
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held", "next"]);
      } finally {
        await Promise.all([first.release(), second.release()]);
      }
    },
  );

  it("does not let stale holds withdraw a reused id", async () => {
    const oldStart = vi.fn(async () => {});
    const { enqueue } = makeQueue("same");
    enqueue("reused", { start: oldStart });
    const hold = holdRun("reused");
    expect(hold.withdraw()).toBe(true);
    expect(scheduler.isSwarmRunActive("reused")).toBe(false);
    const nextStart = vi.fn(async () => {});
    enqueue("reused", { start: nextStart });
    expect(hold.withdraw()).toBe(false);
    expect(hold.bindPreparation({ onRemoved: Promise.resolve(undefined) })).toBe(false);
    await hold.release();
    await flushMicrotasks();
    expect(oldStart).not.toHaveBeenCalled();
    expect(nextStart).toHaveBeenCalledOnce();
    expect(hold.withdraw()).toBe(false);
    expect(scheduler.releaseSwarmRun("reused")).toBe(true);
  });
});
