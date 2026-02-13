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
  enqueueCommand,
  enqueueCommandInLane,
  getActiveTaskCount,
  getQueueSize,
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
    expect(waited as number).toBeGreaterThanOrEqual(5);
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

    // Give the event loop a tick for the task to start.
    await new Promise((r) => setTimeout(r, 5));
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

    // Give the task a tick to start.
    await new Promise((r) => setTimeout(r, 5));

    const drainPromise = waitForActiveTasks(5000);

    // Resolve the blocker after a short delay.
    setTimeout(() => resolve1(), 50);

    const { drained } = await drainPromise;
    expect(drained).toBe(true);

    await task;
  });

  it("waitForActiveTasks returns drained=false on timeout", async () => {
    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => {
      resolve1 = r;
    });

    const task = enqueueCommand(async () => {
      await blocker;
    });

    await new Promise((r) => setTimeout(r, 5));

    const { drained } = await waitForActiveTasks(50);
    expect(drained).toBe(false);

    resolve1();
    await task;
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
    await new Promise((r) => setTimeout(r, 5));

    const drainPromise = waitForActiveTasks(2000);

    // Starts after waitForActiveTasks snapshot and should not block drain completion.
    const second = enqueueCommandInLane(lane, async () => {
      await blocker2;
    });
    await new Promise((r) => setTimeout(r, 5));
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

    // Give the first task a tick to start.
    await new Promise((r) => setTimeout(r, 5));

    const removed = clearCommandLane();
    expect(removed).toBe(1); // only the queued (not active) entry

    // The queued promise should reject.
    await expect(second).rejects.toThrow("Command lane cleared");

    // Let the active task finish normally.
    resolve1();
    await expect(first).resolves.toBe("first");
  });
});
