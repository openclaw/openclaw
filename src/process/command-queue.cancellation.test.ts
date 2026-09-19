import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearCommandLane,
  CommandLaneClearedError,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "./command-queue.js";
import {
  createLaneQueue,
  dequeueLaneQueue,
  enqueueLaneQueue,
  peekLaneQueue,
  type QueueEntry,
  removeLaneQueueEntry,
} from "./command-queue.state.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeEntry(sequence: number): QueueEntry {
  return {
    task: async () => sequence,
    resolve: () => {},
    reject: () => {},
    enqueuedAt: 0,
    sequence,
    priority: 0,
    warnAfterMs: 0,
    queuedAheadAtEnqueue: 0,
    activeAheadAtEnqueue: 0,
  };
}

function measureCancellationWork(count: number) {
  let operations = 0;
  const proxies = new WeakMap<object, object>();
  // Count accesses to queue-owned objects instead of wall time. This keeps the
  // work bound deterministic without depending on ring or list field names.
  function observe<T>(value: T): T {
    if (value === null || typeof value !== "object") {
      return value;
    }
    const existing = proxies.get(value);
    if (existing) {
      return existing as T;
    }
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        operations += 1;
        return observe(Reflect.get(target, key, receiver));
      },
      set(target, key, next, receiver) {
        operations += 1;
        return Reflect.set(target, key, next, receiver);
      },
      deleteProperty(target, key) {
        operations += 1;
        return Reflect.deleteProperty(target, key);
      },
    });
    proxies.set(value, proxy);
    proxies.set(proxy, proxy);
    return proxy;
  }
  const queue = observe(createLaneQueue());
  const entries = Array.from({ length: count }, (_, index) => observe(makeEntry(index)));
  for (const entry of entries) {
    enqueueLaneQueue(queue, entry);
  }
  operations = 0;
  let removed = 0;
  for (const entry of entries.toReversed()) {
    removed += Number(removeLaneQueueEntry(queue, entry));
  }
  const cancellationOperations = operations;
  expect(removed).toBe(count);
  expect(queue.length).toBe(0);
  expect(peekLaneQueue(queue)).toBeUndefined();
  return cancellationOperations;
}

describe("queued command cancellation", () => {
  beforeEach(resetCommandQueueStateForTest);
  afterEach(() => {
    vi.restoreAllMocks();
    resetCommandQueueStateForTest();
  });

  it("preserves priority and FIFO after cancelling heads, middle entries and tails", async () => {
    const lane = "cancellation-order";
    setCommandLaneConcurrency(lane, 0);
    const order: string[] = [];
    const reason = new Error("cancel pending work");
    const priorities = ["background", "normal", "foreground"] as const;
    const pending = priorities.flatMap((priority) =>
      Array.from({ length: 4 }, (_, index) => {
        const controller = new AbortController();
        const label = `${priority}-${index}`;
        return {
          controller,
          index,
          label,
          promise: enqueueCommandInLane(
            lane,
            async () => {
              order.push(label);
              return label;
            },
            { priority, abortSignal: controller.signal },
          ),
        };
      }),
    );
    const outcomes = Promise.allSettled(pending.map((entry) => entry.promise));
    for (const entry of pending) {
      if (entry.index !== 1) {
        entry.controller.abort(reason);
      }
    }
    expect(getCommandLaneSnapshot(lane).queuedCount).toBe(3);
    const refills = priorities.map((priority) =>
      enqueueCommandInLane(
        lane,
        async () => {
          order.push(`${priority}-refill`);
        },
        { priority },
      ),
    );
    setCommandLaneConcurrency(lane, 1);
    const settled = await outcomes;
    await Promise.all(refills);
    expect(settled).toEqual(
      pending.map((entry) =>
        entry.index === 1
          ? { status: "fulfilled", value: entry.label }
          : { status: "rejected", reason },
      ),
    );
    expect(order).toEqual([
      "foreground-1",
      "foreground-refill",
      "normal-1",
      "normal-refill",
      "background-1",
      "background-refill",
    ]);
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
  });

  it("does not search a shared signal for once-listeners that already fired", async () => {
    const lane = "cancellation-shared-signal";
    setCommandLaneConcurrency(lane, 0);
    const controller = new AbortController();
    const task = vi.fn(async () => "unexpected");
    const pending = Array.from({ length: 8 }, () =>
      enqueueCommandInLane(lane, task, { abortSignal: controller.signal }),
    );
    const outcomes = Promise.allSettled(pending);
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("shared owner stopped");
    controller.abort(reason);
    expect(removeListener).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(await outcomes).toEqual(pending.map(() => ({ status: "rejected", reason })));
    expect(task).not.toHaveBeenCalled();
    expect(getCommandLaneSnapshot(lane).queuedCount).toBe(0);
    setCommandLaneConcurrency(lane, 1);
    await expect(enqueueCommandInLane(lane, async () => "refilled")).resolves.toBe("refilled");
  });

  it("detaches queued cancellation on admission and clear without cancelling active work", async () => {
    const lane = "cancellation-admission";
    const controller = new AbortController();
    const gate = createDeferred<string>();
    const active = enqueueCommandInLane(lane, async () => await gate.promise, {
      abortSignal: controller.signal,
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const queued = enqueueCommandInLane(lane, async () => "unexpected", {
      abortSignal: controller.signal,
    });
    const rejection = expect(queued).rejects.toBeInstanceOf(CommandLaneClearedError);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    expect(clearCommandLane(lane)).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort(new Error("too late to cancel admission"));
    gate.resolve("active finished");
    await rejection;
    await expect(active).resolves.toBe("active finished");
  });

  it.each(["dequeue", "cancel"] as const)(
    "releases entry references before reentrant %s cleanup",
    (removal) => {
      const queue = createLaneQueue();
      const entries = [makeEntry(0), makeEntry(1), makeEntry(2)];
      for (const entry of entries) {
        enqueueLaneQueue(queue, entry);
      }
      const removed = entries[removal === "dequeue" ? 0 : 1]!;
      const refill = makeEntry(3);
      const release = vi.fn(() => {
        expect(removed.queued).toBeUndefined();
        expect(removed.releaseQueuedAbort).toBeUndefined();
        for (const entry of entries) {
          expect(Object.values(removed)).not.toContain(entry);
        }
        expect(queue.length).toBe(2);
        expect(removeLaneQueueEntry(queue, removed)).toBe(false);
        enqueueLaneQueue(queue, refill);
      });
      removed.releaseQueuedAbort = release;
      if (removal === "dequeue") {
        expect(dequeueLaneQueue(queue)).toBe(removed);
      } else {
        expect(removeLaneQueueEntry(queue, removed)).toBe(true);
      }
      expect(release).toHaveBeenCalledOnce();
      const survivors = entries.filter((entry) => entry !== removed);
      expect([dequeueLaneQueue(queue), dequeueLaneQueue(queue), dequeueLaneQueue(queue)]).toEqual([
        ...survivors,
        refill,
      ]);
      expect(dequeueLaneQueue(queue)).toBeUndefined();
      enqueueLaneQueue(queue, makeEntry(4));
      expect(dequeueLaneQueue(queue)?.sequence).toBe(4);
      expect(queue.length).toBe(0);
    },
  );

  it("keeps total cancellation work linear as a backlog doubles", () => {
    const smaller = measureCancellationWork(128);
    const larger = measureCancellationWork(256);
    expect(larger).toBeLessThan(smaller * 3);
  });
});
