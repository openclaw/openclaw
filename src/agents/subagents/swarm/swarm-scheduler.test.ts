import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { PluginRuntimeCloseRetainedError } from "../../../plugins/runtime-close-error.js";
import {
  activateSwarmRun,
  bindSwarmRunReservation,
  closeSwarmScheduler,
  enqueueSwarmRun,
  isSwarmRunActive,
  isSwarmRunWaitingForCapacity,
  holdQueuedSwarmRun,
  releaseSwarmRun,
  reserveSwarmRun,
} from "./swarm-scheduler.js";
import { testing } from "./swarm-scheduler.test-support.js";

// queueMicrotask-driven starts need real microtask turns; fake timers'
// runAllTicks only drains nextTick, so flush the microtask queue explicitly.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

describe("swarm scheduler", () => {
  beforeEach(() => {
    testing.reset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("preserves admission order when later preparation finishes first", async () => {
    const started: string[] = [];
    const reserve = (runId: string) =>
      reserveSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 1,
        activeRunIds: [],
      });
    const activate = (runId: string) =>
      activateSwarmRun({
        groupId: "group",
        runId,
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

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
    const started: string[] = [];
    const enqueue = (runId: string) =>
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 1,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

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
    reserveSwarmRun({ groupId: "unprepared", runId: "child", maxConcurrent: 1, activeRunIds: [] });
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
      reserveSwarmRun({ groupId: "prepared", runId: "child", maxConcurrent: 1, activeRunIds: [] });
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
    for (const [runId, onRemoved] of [
      ["failed", failedCleanup],
      ["pending", pendingCleanup],
    ] as const) {
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 1,
        activeRunIds: ["capacity"],
        lifecycleOwner,
        start: async () => undefined,
        onStartFailure: () => true,
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
    const entered = createDeferred();
    const finishLaunch = createDeferred();
    const onRemoved = vi.fn(async () => undefined);
    enqueueSwarmRun({
      groupId: "released-launch",
      runId: "pending-launch",
      maxConcurrent: 1,
      activeRunIds: [],
      lifecycleOwner,
      start: async () => {
        entered.resolve();
        await finishLaunch.promise;
      },
      onStartFailure: () => true,
      onRemoved,
    });
    await entered.promise;
    expect(releaseSwarmRun("pending-launch")).toBe(true);
    const closing = closeSwarmScheduler(lifecycleOwner);
    try {
      await flushMicrotasks();
      expect(onRemoved).not.toHaveBeenCalled();
    } finally {
      finishLaunch.resolve();
    }
    await closing;
    expect(onRemoved).toHaveBeenCalledExactlyOnceWith("shutdown");
  });

  it("keeps a live reservation queued when a later snapshot reports it active", async () => {
    expect(
      reserveSwarmRun({
        groupId: "group",
        runId: "queued",
        maxConcurrent: 1,
        activeRunIds: [],
      }),
    ).toBe(true);
    expect(
      reserveSwarmRun({
        groupId: "group",
        runId: "next",
        maxConcurrent: 1,
        activeRunIds: ["queued"],
      }),
    ).toBe(true);

    const started: string[] = [];
    activateSwarmRun({
      groupId: "group",
      runId: "queued",
      start: async () => {
        started.push("queued");
      },
      onStartFailure: vi.fn(() => true),
    });
    await vi.waitFor(() => expect(started).toEqual(["queued"]));
    activateSwarmRun({
      groupId: "group",
      runId: "next",
      start: async () => {
        started.push("next");
      },
      onStartFailure: () => true,
    });
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
    enqueueSwarmRun({
      groupId: "group",
      runId: "broken",
      maxConcurrent: 1,
      activeRunIds: [],
      start,
      onStartFailure: () => {
        failed.resolve();
        throw failure;
      },
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "next",
      maxConcurrent: 1,
      activeRunIds: [],
      start: next,
      onStartFailure: () => true,
    });
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
    const started: string[] = [];
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "failed",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.push("failed");
        throw new Error("launch failed");
      },
      onStartFailure: async () => {
        await cleanup;
        return true;
      },
    });
    enqueueSwarmRun({
      groupId: "group",
      runId: "next",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.push("next");
      },
      onStartFailure: vi.fn(() => true),
    });

    await vi.waitFor(() => expect(started).toEqual(["failed"]));
    finishCleanup?.();
    await vi.waitFor(() => expect(started).toEqual(["failed", "next"]));
  });

  it("refreshes the lane limit before rejecting a duplicate reservation", async () => {
    const started: string[] = [];
    const enqueue = (runId: string) =>
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent: 2,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

    enqueue("one");
    enqueue("two");
    enqueue("three");
    const owner = {};
    const waits: boolean[] = [];
    bindSwarmRunReservation("three", owner, () => {
      waits.push(isSwarmRunWaitingForCapacity("three", owner));
    });
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));

    expect(
      reserveSwarmRun({
        groupId: "group",
        runId: "one",
        maxConcurrent: 1,
        activeRunIds: ["one", "two"],
      }),
    ).toBe(false);
    expect(releaseSwarmRun("one")).toBe(true);
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    expect(waits).toEqual([true]);
    expect(releaseSwarmRun("two")).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
    expect(waits).toEqual([true, false]);
  });

  it("fills increased capacity from the existing FIFO queue", async () => {
    const started: string[] = [];
    const enqueue = (runId: string, maxConcurrent: number) =>
      enqueueSwarmRun({
        groupId: "group",
        runId,
        maxConcurrent,
        activeRunIds: [],
        start: async () => {
          started.push(runId);
        },
        onStartFailure: vi.fn(() => true),
      });

    enqueue("one", 1);
    enqueue("two", 1);
    enqueue("three", 3);

    await vi.waitFor(() => expect(started).toEqual(["one", "two", "three"]));
  });

  it.each(["before", "during"])(
    "holds FIFO across activation %s the hold and overlapping cancellations",
    async (activation) => {
      const started: string[] = [];
      reserveSwarmRun({ groupId: "group", runId: "held", maxConcurrent: 1, activeRunIds: [] });
      const activate = () =>
        activateSwarmRun({
          groupId: "group",
          runId: "held",
          start: async () => {
            started.push("held");
          },
          onStartFailure: () => true,
        });
      if (activation === "before") {
        activate();
      }
      const first = holdQueuedSwarmRun("held");
      const second = holdQueuedSwarmRun("held");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (activation === "during") {
        activate();
      }
      for (const [runId, groupId] of [
        ["next", "group"],
        ["foreign", "other-group"],
      ] as const) {
        enqueueSwarmRun({
          groupId,
          runId,
          maxConcurrent: 1,
          activeRunIds: [],
          start: async () => {
            started.push(runId);
          },
          onStartFailure: () => true,
        });
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
    enqueueSwarmRun({
      groupId: "same",
      runId: "reused",
      maxConcurrent: 1,
      activeRunIds: [],
      start: oldStart,
      onStartFailure: () => true,
    });
    const hold = holdQueuedSwarmRun("reused");
    expect(hold).toBeDefined();
    expect(hold?.withdraw()).toBe(true);
    expect(isSwarmRunActive("reused")).toBe(false);
    const nextStart = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "same",
      runId: "reused",
      maxConcurrent: 1,
      activeRunIds: [],
      start: nextStart,
      onStartFailure: () => true,
    });
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
