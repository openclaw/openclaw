import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logging/diagnostic.js", () => ({
  logLaneEnqueue: diagnosticMocks.logLaneEnqueue,
  logLaneDequeue: diagnosticMocks.logLaneDequeue,
  diagnosticLogger: diagnosticMocks.diag,
}));

import {
  clearCommandLane,
  CommandLaneClearedError,
  enqueueCommand,
  enqueueCommandInLane,
  getActiveTaskCount,
  getQueueSize,
  getTotalQueueSize,
  resetAllLanes,
  setCommandLaneConcurrency,
  waitForActiveTasks,
} from "./command-queue.js";

describe("command queue", () => {
  beforeEach(() => {
    diagnosticMocks.logLaneEnqueue.mockClear();
    diagnosticMocks.logLaneDequeue.mockClear();
    diagnosticMocks.diag.debug.mockClear();
    diagnosticMocks.diag.warn.mockClear();
    diagnosticMocks.diag.error.mockClear();
  });

  it("resetAllLanes is safe when no lanes have been created", () => {
    expect(getActiveTaskCount()).toBe(0);
    expect(() => resetAllLanes()).not.toThrow();
    expect(getActiveTaskCount()).toBe(0);
  });

  it("runs tasks one at a time in order", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: number[] = [];

    const makeTask = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(id);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return id;
    };

    const results = await Promise.all([
      enqueueCommand(makeTask(1)),
      enqueueCommand(makeTask(2)),
      enqueueCommand(makeTask(3)),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(calls).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(getQueueSize()).toBe(0);
  });

  it("logs enqueue depth after push", async () => {
    const task = enqueueCommand(async () => {});

    expect(diagnosticMocks.logLaneEnqueue).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logLaneEnqueue.mock.calls[0]?.[1]).toBe(1);

    await task;
  });

  it("invokes onWait callback when a task waits past the threshold", async () => {
    let waited: number | null = null;
    let queuedAhead: number | null = null;

    // First task holds the queue long enough to trigger wait notice.
    const first = enqueueCommand(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const second = enqueueCommand(async () => {}, {
      warnAfterMs: 5,
      onWait: (ms, ahead) => {
        waited = ms;
        queuedAhead = ahead;
      },
    });

    await Promise.all([first, second]);

    expect(waited).not.toBeNull();
    expect(waited as unknown as number).toBeGreaterThanOrEqual(5);
    expect(queuedAhead).toBe(0);
  });

  it("getActiveTaskCount returns count of currently executing tasks", async () => {
    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    const task = enqueueCommand(async () => {
      await blocker;
    });

    expect(getActiveTaskCount()).toBe(1);

    resolve1();
    await task;
    expect(getActiveTaskCount()).toBe(0);
  });

  it("waitForActiveTasks resolves immediately when no tasks are active", async () => {
    const { drained } = await waitForActiveTasks(1000);
    expect(drained).toBe(true);
  });

  it("waitForActiveTasks waits for active tasks to finish", async () => {
    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    const task = enqueueCommand(async () => {
      await blocker;
    });

    vi.useFakeTimers();
    try {
      const drainPromise = waitForActiveTasks(5000);

      // Resolve the blocker after a short delay.
      setTimeout(() => resolve1(), 10);
      await vi.advanceTimersByTimeAsync(100);

      const { drained } = await drainPromise;
      expect(drained).toBe(true);

      await task;
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitForActiveTasks returns drained=false on timeout", async () => {
    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    const task = enqueueCommand(async () => {
      await blocker;
    });

    vi.useFakeTimers();
    try {
      const waitPromise = waitForActiveTasks(50);
      await vi.advanceTimersByTimeAsync(100);
      const { drained } = await waitPromise;
      expect(drained).toBe(false);

      resolve1();
      await task;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetAllLanes drains queued work immediately after reset", async () => {
    const lane = `reset-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    // Start a task that blocks the lane
    const task1 = enqueueCommandInLane(lane, async () => {
      await blocker;
    });

    await vi.waitFor(() => {
      expect(getActiveTaskCount()).toBeGreaterThanOrEqual(1);
    });

    // Enqueue another task — it should be stuck behind the blocker
    let task2Ran = false;
    const task2 = enqueueCommandInLane(lane, async () => {
      task2Ran = true;
    });

    await vi.waitFor(() => {
      expect(getQueueSize(lane)).toBeGreaterThanOrEqual(2);
    });
    expect(task2Ran).toBe(false);

    // Simulate SIGUSR1: reset all lanes. Queued work (task2) should be
    // drained immediately — no fresh enqueue needed.
    resetAllLanes();

    // Complete the stale in-flight task; generation mismatch makes its
    // completion path a no-op for queue bookkeeping.
    resolve1();
    await task1;

    // task2 should have been pumped by resetAllLanes's drain pass.
    await task2;
    expect(task2Ran).toBe(true);
  });

  it("waitForActiveTasks ignores tasks that start after the call", async () => {
    const lane = `drain-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 2);

    let resolve1!: () => void;
    const blocker1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    let resolve2!: () => void;
    const blocker2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    const first = enqueueCommandInLane(lane, async () => {
      await blocker1;
    });
    const drainPromise = waitForActiveTasks(2000);

    // Starts after waitForActiveTasks snapshot and should not block drain completion.
    const second = enqueueCommandInLane(lane, async () => {
      await blocker2;
    });
    expect(getActiveTaskCount()).toBeGreaterThanOrEqual(2);

    resolve1();
    const { drained } = await drainPromise;
    expect(drained).toBe(true);

    resolve2();
    await Promise.all([first, second]);
  });

  it("clearCommandLane rejects pending promises", async () => {
    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    // First task blocks the lane.
    const first = enqueueCommand(async () => {
      await blocker;
      return "first";
    });

    // Second task is queued behind the first.
    const second = enqueueCommand(async () => "second");

    const removed = clearCommandLane();
    expect(removed).toBe(1); // only the queued (not active) entry

    // The queued promise should reject.
    await expect(second).rejects.toBeInstanceOf(CommandLaneClearedError);

    // Let the active task finish normally.
    resolve1();
    await expect(first).resolves.toBe("first");
  });

  // ─── Safety net: Lane isolation ───────────────────────────────────
  // Prove that tasks on different lanes run independently.

  describe("lane isolation", () => {
    it("tasks on different lanes run concurrently", async () => {
      // Two lanes with concurrency 1 each — tasks should overlap.
      const timeline: string[] = [];

      const laneATask = enqueueCommandInLane("lane-a", async () => {
        timeline.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        timeline.push("a-end");
      });

      const laneBTask = enqueueCommandInLane("lane-b", async () => {
        timeline.push("b-start");
        await new Promise((r) => setTimeout(r, 30));
        timeline.push("b-end");
      });

      await Promise.all([laneATask, laneBTask]);

      // Both should have started before either finished.
      const aStart = timeline.indexOf("a-start");
      const bStart = timeline.indexOf("b-start");
      const aEnd = timeline.indexOf("a-end");
      const bEnd = timeline.indexOf("b-end");

      expect(aStart).toBeLessThan(aEnd);
      expect(bStart).toBeLessThan(bEnd);
      // Both start before either ends = true parallelism.
      expect(bStart).toBeLessThan(aEnd);
    });

    it("tasks on the same lane run serially", async () => {
      const timeline: string[] = [];

      const t1 = enqueueCommandInLane("serial-lane", async () => {
        timeline.push("1-start");
        await new Promise((r) => setTimeout(r, 20));
        timeline.push("1-end");
      });

      const t2 = enqueueCommandInLane("serial-lane", async () => {
        timeline.push("2-start");
        await new Promise((r) => setTimeout(r, 10));
        timeline.push("2-end");
      });

      await Promise.all([t1, t2]);

      // Task 2 must not start until task 1 is done.
      expect(timeline).toEqual(["1-start", "1-end", "2-start", "2-end"]);
    });

    it("getQueueSize returns size for a specific lane only", async () => {
      let resolve1!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve1 = r;
      });

      const t1 = enqueueCommandInLane("size-lane-a", async () => {
        await blocker;
      });

      // lane-a should have 1 active task.
      expect(getQueueSize("size-lane-a")).toBe(1);
      // lane-b should have 0.
      expect(getQueueSize("size-lane-b")).toBe(0);

      resolve1();
      await t1;
    });
  });

  // ─── Safety net: Concurrency control ──────────────────────────────
  // Prove that setCommandLaneConcurrency actually limits/expands parallelism.

  describe("concurrency control", () => {
    it("setCommandLaneConcurrency allows multiple tasks to run in parallel", async () => {
      setCommandLaneConcurrency("concurrent-lane", 3);

      let active = 0;
      let maxActive = 0;

      const makeTask = () => async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
      };

      await Promise.all([
        enqueueCommandInLane("concurrent-lane", makeTask()),
        enqueueCommandInLane("concurrent-lane", makeTask()),
        enqueueCommandInLane("concurrent-lane", makeTask()),
      ]);

      // All 3 should run simultaneously since concurrency is 3.
      expect(maxActive).toBe(3);
    });

    it("concurrency limit is respected even with more tasks than slots", async () => {
      setCommandLaneConcurrency("limited-lane", 2);

      let active = 0;
      let maxActive = 0;

      const makeTask = (id: number) => async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return id;
      };

      const results = await Promise.all([
        enqueueCommandInLane("limited-lane", makeTask(1)),
        enqueueCommandInLane("limited-lane", makeTask(2)),
        enqueueCommandInLane("limited-lane", makeTask(3)),
        enqueueCommandInLane("limited-lane", makeTask(4)),
      ]);

      // Max 2 concurrent, all complete.
      expect(maxActive).toBe(2);
      expect(results).toEqual([1, 2, 3, 4]);
    });
  });

  // ─── Safety net: clearCommandLane ─────────────────────────────────
  // Prove that clearing a lane actually removes queued tasks.

  describe("clearCommandLane", () => {
    it("removes pending tasks from a lane", async () => {
      let resolve1!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve1 = r;
      });

      // First task blocks the lane.
      const t1 = enqueueCommandInLane("clear-test-lane", async () => {
        await blocker;
        return "first";
      });

      // Queue up more tasks behind the blocker (catch rejections from clearCommandLane).
      const _t2Promise = enqueueCommandInLane("clear-test-lane", async () => "second").catch(
        () => {},
      );
      const _t3Promise = enqueueCommandInLane("clear-test-lane", async () => "third").catch(
        () => {},
      );

      // Lane should show 3 total (1 active + 2 queued).
      expect(getQueueSize("clear-test-lane")).toBe(3);

      // Clear the queue.
      const removed = clearCommandLane("clear-test-lane");
      expect(removed).toBe(2); // 2 pending removed.

      // Lane should now show only the active task.
      expect(getQueueSize("clear-test-lane")).toBe(1);

      // Let the first task finish.
      resolve1();
      const result1 = await t1;
      expect(result1).toBe("first");

      // Queue should be empty now.
      expect(getQueueSize("clear-test-lane")).toBe(0);
    });
  });

  // ─── Safety net: getTotalQueueSize ────────────────────────────────

  describe("getTotalQueueSize", () => {
    it("counts tasks across all lanes", async () => {
      let resolveA!: () => void;
      let resolveB!: () => void;
      const blockerA = new Promise<void>((r) => {
        resolveA = r;
      });
      const blockerB = new Promise<void>((r) => {
        resolveB = r;
      });

      const tA = enqueueCommandInLane("total-a", async () => {
        await blockerA;
      });
      const tB = enqueueCommandInLane("total-b", async () => {
        await blockerB;
      });

      // Each lane has 1 active task = 2 total.
      const total = getTotalQueueSize();
      expect(total).toBeGreaterThanOrEqual(2);

      resolveA();
      resolveB();
      await Promise.all([tA, tB]);
    });
  });

  // ─── Safety net: Error handling ───────────────────────────────────
  // Prove queue continues processing after a task throws.

  describe("error recovery", () => {
    it("queue continues after a task throws", async () => {
      const t1 = enqueueCommandInLane("error-lane", async () => {
        throw new Error("boom");
      }).catch((e: Error) => e.message);

      const t2 = enqueueCommandInLane("error-lane", async () => "survived");

      const [r1, r2] = await Promise.all([t1, t2]);

      expect(r1).toBe("boom");
      expect(r2).toBe("survived");
    });
  });

  // ─── Safety net: enqueueCommand defaults to main lane ─────────────

  describe("default lane routing", () => {
    it("enqueueCommand uses the main lane", async () => {
      let resolve1!: () => void;
      const blocker = new Promise<void>((r) => {
        resolve1 = r;
      });

      const t1 = enqueueCommand(async () => {
        await blocker;
      });

      // Main lane should have 1 task.
      expect(getQueueSize("main")).toBe(1);
      expect(getQueueSize()).toBe(1); // default parameter

      resolve1();
      await t1;
    });
  });
});
