import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
let PluginRuntimeCloseRetainedError: typeof import("../../../plugins/runtime-close-error.js").PluginRuntimeCloseRetainedError;
let activateSwarmRun: typeof import("./swarm-scheduler.js").activateSwarmRun;
let bindSwarmRunReservation: typeof import("./swarm-scheduler.js").bindSwarmRunReservation;
let closeSwarmScheduler: typeof import("./swarm-scheduler.js").closeSwarmScheduler;
let enqueueSwarmRun: typeof import("./swarm-scheduler.js").enqueueSwarmRun;
let isSwarmRunActive: typeof import("./swarm-scheduler.js").isSwarmRunActive;
let isSwarmRunWaitingForCapacity: typeof import("./swarm-scheduler.js").isSwarmRunWaitingForCapacity;
let holdQueuedSwarmRun: typeof import("./swarm-scheduler.js").holdQueuedSwarmRun;
let releaseSwarmRun: typeof import("./swarm-scheduler.js").releaseSwarmRun;
let reserveSwarmRun: typeof import("./swarm-scheduler.js").reserveSwarmRun;

// queueMicrotask-driven starts need real microtask turns; fake timers'
// runAllTicks only drains nextTick, so flush the microtask queue explicitly.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

function makeQueue(groupId = "group", maxConcurrent = 1) {
  const started: string[] = [];
  const reserve = (runId: string, overrides: Partial<Parameters<typeof reserveSwarmRun>[0]> = {}) =>
    reserveSwarmRun({ groupId, runId, maxConcurrent, activeRunIds: [], ...overrides });
  const launch = (runId: string) => ({
    groupId,
    runId,
    start: async () => {
      started.push(runId);
    },
    onStartFailure: () => true,
  });
  const activate = (runId: string) => activateSwarmRun(launch(runId));
  const enqueue = (runId: string, overrides: Partial<Parameters<typeof enqueueSwarmRun>[0]> = {}) =>
    enqueueSwarmRun({ maxConcurrent, activeRunIds: [], ...launch(runId), ...overrides });
  return { started, reserve, activate, enqueue };
}

describe("swarm scheduler", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      activateSwarmRun,
      bindSwarmRunReservation,
      closeSwarmScheduler,
      enqueueSwarmRun,
      isSwarmRunActive,
      isSwarmRunWaitingForCapacity,
      holdQueuedSwarmRun,
      releaseSwarmRun,
      reserveSwarmRun,
    } = await import("./swarm-scheduler.js"));
    ({ PluginRuntimeCloseRetainedError } = await import("../../../plugins/runtime-close-error.js"));
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(async () => {
    try {
      await closeSwarmScheduler();
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
    bindSwarmRunReservation("two", owner);
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    activate("two");
    await Promise.resolve();
    expect(started).toEqual([]);
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(false);

    activate("one");
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    expect(isSwarmRunWaitingForCapacity("two", {})).toBe(false);
    expect(releaseSwarmRun("one")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
  });

  it("removes a cancelled queued run before the next slot opens", async () => {
    const { started, enqueue } = makeQueue();
    enqueue("one");
    enqueue("two");
    enqueue("three");
    const owner = {};
    const waits: boolean[] = [];
    bindSwarmRunReservation("two", owner, () => {
      waits.push(isSwarmRunWaitingForCapacity("two", owner));
    });
    await vi.waitFor(() => expect(started).toEqual(["one"]));
    const hold = holdQueuedSwarmRun("two");
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(false);
    await hold?.release();
    expect(isSwarmRunWaitingForCapacity("two", owner)).toBe(true);
    const removal = holdQueuedSwarmRun("two");
    assert(removal);
    try {
      expect(removal.withdraw()).toBe(true);
      expect(waits).toEqual([true, false, true, false]);
      releaseSwarmRun("one");
      await vi.waitFor(() => expect(started).toEqual(["one", "three"]));
    } finally {
      await removal.release();
    }
  });

  it("does not certify an unactivated reservation without a preparation owner", async () => {
    makeQueue("unprepared").reserve("child");
    const released = holdQueuedSwarmRun("child");
    assert(released);
    await released.release();
    expect(released.bindPreparation({ onRemoved: Promise.resolve(undefined) })).toBe(false);
    const hold = holdQueuedSwarmRun("child");
    assert(hold);
    expect(hold.withdraw()).toBe(true);
    expect(await hold.settleCancellation()).toBe(false);
    await hold.release();
  });

  it.each(["success", "failure", "shutdown"] as const)(
    "joins owned preactivation cleanup without certifying %s incorrectly",
    async (mode) => {
      const owner = {};
      const ready = createDeferred<Parameters<typeof activateSwarmRun>[0]["onRemoved"]>();
      const entered = createDeferred();
      const release = createDeferred();
      const failure = new Error("preparation cleanup failed");
      makeQueue("prepared").reserve("child");
      const producer = holdQueuedSwarmRun("child");
      assert(producer);
      expect(producer.bindPreparation({ onRemoved: ready.promise, lifecycleOwner: owner })).toBe(
        true,
      );
      const cancellation = holdQueuedSwarmRun("child");
      assert(cancellation);
      expect(cancellation.withdraw()).toBe(true);
      const published = vi.fn();
      const settlement = cancellation.settleCancellation().then(
        (qualified) => {
          if (qualified) {
            published();
          }
          return { qualified };
        },
        (error: unknown) => ({ error }),
      );
      ready.resolve(async () => {
        entered.resolve();
        await release.promise;
        if (mode === "failure") {
          throw failure;
        }
      });
      let closing: Promise<void> | undefined;
      try {
        await entered.promise;
        expect(published).not.toHaveBeenCalled();
        if (mode === "shutdown") {
          closing = closeSwarmScheduler(owner);
        }
        release.resolve();
        expect(await settlement).toEqual(
          mode === "failure" ? { error: failure } : { qualified: mode === "success" },
        );
        expect(published).toHaveBeenCalledTimes(mode === "success" ? 1 : 0);
      } finally {
        release.resolve();
        await Promise.all([producer.release(), cancellation.release(), closing]);
      }
      if (mode === "failure") {
        await expect(closeSwarmScheduler(owner)).rejects.toMatchObject({ errors: [failure] });
      }
    },
  );

  it("joins removed queues and preserves retained cleanup failures", async () => {
    const lifecycleOwner = {};
    const failure = new PluginRuntimeCloseRetainedError(new Error("cleanup still owns resources"));
    const releaseCleanup = createDeferred();
    const failedCleanup = vi.fn(async () => {
      throw failure;
    });
    const pendingCleanup = vi.fn(async () => {
      await releaseCleanup.promise;
    });
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
      const hold = holdQueuedSwarmRun(runId);
      assert(hold);
      expect(hold.withdraw()).toBe(true);
      releases.push(hold.release());
    }
    let closed = false;
    const closing = closeSwarmScheduler(lifecycleOwner).then(
      () => {
        closed = true;
      },
      (error: unknown) => {
        closed = true;
        return error;
      },
    );
    try {
      await vi.waitFor(() => expect(pendingCleanup).toHaveBeenCalledOnce());
      expect(closed).toBe(false);
    } finally {
      releaseCleanup.resolve();
    }
    await expect(Promise.all(releases)).resolves.toEqual([undefined, undefined]);
    expect(await closing).toMatchObject({ errors: [failure] });
    await expect(closeSwarmScheduler(lifecycleOwner)).rejects.toMatchObject({
      errors: [failure],
    });
    expect(failedCleanup).toHaveBeenCalledOnce();
    expect(pendingCleanup).toHaveBeenCalledOnce();
    expect(releaseSwarmRun("capacity")).toBe(true);
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
    expect(releaseSwarmRun("pending-launch")).toBe(true);
    const closing = closeSwarmScheduler(lifecycleOwner);
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
    releaseSwarmRun("queued");
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
      expect(isSwarmRunActive("broken")).toBe(true);
      expect(warning).toHaveBeenCalledWith(
        "[swarm] Failed launch cleanup: Error: persistence failed",
      );
      await closeSwarmScheduler();
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
    const { started, enqueue, reserve } = makeQueue("group", 2);
    enqueue("one");
    enqueue("two");
    enqueue("three");
    const owner = {};
    const waits: boolean[] = [];
    bindSwarmRunReservation("three", owner, () => {
      waits.push(isSwarmRunWaitingForCapacity("three", owner));
    });
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));

    expect(reserve("one", { maxConcurrent: 1, activeRunIds: ["one", "two"] })).toBe(false);
    expect(releaseSwarmRun("one")).toBe(true);
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    expect(waits).toEqual([true]);
    expect(releaseSwarmRun("two")).toBe(true);
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
      const first = holdQueuedSwarmRun("held");
      const second = holdQueuedSwarmRun("held");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (activation === "during") {
        activate("held");
      }
      for (const [runId, groupId] of [
        ["next", "group"],
        ["foreign", "other-group"],
      ] as const) {
        enqueue(runId, { groupId });
      }
      try {
        await flushMicrotasks();
        expect(started).toEqual(["foreign"]);
        expect(isSwarmRunActive("held")).toBe(false);
        await Promise.all([first?.release(), first?.release()]);
        await flushMicrotasks();
        expect(started).toEqual(["foreign"]);
        await second?.release();
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held"]);
        expect(isSwarmRunActive("held")).toBe(true);
        releaseSwarmRun("held");
        await flushMicrotasks();
        expect(started).toEqual(["foreign", "held", "next"]);
      } finally {
        await Promise.all([first?.release(), second?.release()]);
      }
    },
  );

  it("does not let stale holds withdraw a reused id", async () => {
    const oldStart = vi.fn(async () => {});
    const { enqueue } = makeQueue("same");
    enqueue("reused", { start: oldStart });
    const hold = holdQueuedSwarmRun("reused");
    expect(hold).toBeDefined();
    expect(hold?.withdraw()).toBe(true);
    expect(isSwarmRunActive("reused")).toBe(false);
    const nextStart = vi.fn(async () => {});
    enqueue("reused", { start: nextStart });
    expect(hold?.withdraw()).toBe(false);
    expect(hold?.bindPreparation({ onRemoved: Promise.resolve(undefined) })).toBe(false);
    await hold?.release();
    await flushMicrotasks();
    expect(oldStart).not.toHaveBeenCalled();
    expect(nextStart).toHaveBeenCalledOnce();
    expect(hold?.withdraw()).toBe(false);
    expect(releaseSwarmRun("reused")).toBe(true);
  });
});
