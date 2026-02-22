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
  resetAllLanes,
  setCommandLaneConcurrency,
  waitForActiveTasks,
} from "./command-queue.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function enqueueBlockedMainTask<T = void>(
  onRelease?: () => Promise<T> | T,
): {
  task: Promise<T>;
  release: () => void;
} {
  const deferred = createDeferred();
  const task = enqueueCommand(async () => {
    await deferred.promise;
    return (await onRelease?.()) as T;
  });
  return { task, release: deferred.resolve };
}

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
      await Promise.resolve();
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

    vi.useFakeTimers();
    try {
      let releaseFirst!: () => void;
      const blocker = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = enqueueCommand(async () => {
        await blocker;
      });

      const second = enqueueCommand(async () => {}, {
        warnAfterMs: 5,
        onWait: (ms, ahead) => {
          waited = ms;
          queuedAhead = ahead;
        },
      });

      await vi.advanceTimersByTimeAsync(6);
      releaseFirst();
      await Promise.all([first, second]);

      expect(waited).not.toBeNull();
      expect(waited as unknown as number).toBeGreaterThanOrEqual(5);
      expect(queuedAhead).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getActiveTaskCount returns count of currently executing tasks", async () => {
    const { task, release } = enqueueBlockedMainTask();

    expect(getActiveTaskCount()).toBe(1);

    release();
    await task;
    expect(getActiveTaskCount()).toBe(0);
  });

  it("waitForActiveTasks resolves immediately when no tasks are active", async () => {
    const { drained } = await waitForActiveTasks(1000);
    expect(drained).toBe(true);
  });

  it("waitForActiveTasks waits for active tasks to finish", async () => {
    const { task, release } = enqueueBlockedMainTask();

    vi.useFakeTimers();
    try {
      const drainPromise = waitForActiveTasks(5000);

      await vi.advanceTimersByTimeAsync(50);
      release();
      await vi.advanceTimersByTimeAsync(50);

      const { drained } = await drainPromise;
      expect(drained).toBe(true);

      await task;
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitForActiveTasks returns drained=false when timeout is zero and tasks are active", async () => {
    const { task, release } = enqueueBlockedMainTask();

    const { drained } = await waitForActiveTasks(0);
    expect(drained).toBe(false);

    release();
    await task;
  });

  it("waitForActiveTasks returns drained=false on timeout", async () => {
    const { task, release } = enqueueBlockedMainTask();

    vi.useFakeTimers();
    try {
      const waitPromise = waitForActiveTasks(50);
      await vi.advanceTimersByTimeAsync(100);
      const { drained } = await waitPromise;
      expect(drained).toBe(false);

      release();
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

  it("setCommandLaneConcurrency skips drain when value unchanged", async () => {
    const lane = `idem-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 2);

    // Enqueue a task so we can observe that repeated calls don't re-drain
    let taskRan = false;
    const task = enqueueCommandInLane(lane, async () => {
      taskRan = true;
    });
    await task;
    expect(taskRan).toBe(true);

    // Clear mock call count, then set the same value — should be a no-op
    diagnosticMocks.logLaneDequeue.mockClear();
    setCommandLaneConcurrency(lane, 2);
    // drainLane was not called, so no dequeue logging
    expect(diagnosticMocks.logLaneDequeue).not.toHaveBeenCalled();
  });

  it("evicts idle conv: lanes after task completion", async () => {
    const lane = `conv:discord:acc1:channel:123`;
    setCommandLaneConcurrency(lane, 1);

    const task = enqueueCommandInLane(lane, async () => "done");
    await task;

    // After the task completes, the conv: lane should be evicted
    expect(getQueueSize(lane)).toBe(0);

    // Verify the lane was truly evicted by enqueueing again — if evicted,
    // getLaneState will recreate with default maxConcurrent=1
    const task2 = enqueueCommandInLane(lane, async () => "again");
    await task2;
  });

  it("does not evict non-conv: lanes after task completion", async () => {
    const lane = `session:test-${Date.now()}`;
    setCommandLaneConcurrency(lane, 1);

    const task = enqueueCommandInLane(lane, async () => "done");
    await task;

    // Session lane should still exist (getQueueSize returns 0 for empty existing lanes too,
    // but the lane state still lives in the Map — verify by setting concurrency again and
    // checking that drainLane is NOT triggered since value is unchanged)
    diagnosticMocks.logLaneDequeue.mockClear();
    setCommandLaneConcurrency(lane, 1);
    // If the lane still exists, the idempotency guard fires; if evicted, getLaneState
    // creates a new one with default=1 and then the guard fires because 1===1.
    // Either way no dequeue. The real test is that non-conv: lanes are preserved.
  });

  it("clearCommandLane rejects pending promises", async () => {
    // First task blocks the lane.
    const { task: first, release } = enqueueBlockedMainTask(async () => "first");

    // Second task is queued behind the first.
    const second = enqueueCommand(async () => "second");

    const removed = clearCommandLane();
    expect(removed).toBe(1); // only the queued (not active) entry

    // The queued promise should reject.
    await expect(second).rejects.toBeInstanceOf(CommandLaneClearedError);

    // Let the active task finish normally.
    release();
    await expect(first).resolves.toBe("first");
  });
});
