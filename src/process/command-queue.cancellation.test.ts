import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  enqueueCommandInLane as enqueue,
  getCommandLaneSnapshot as snapshot,
  getQueueSize,
  setCommandLaneConcurrency as setConcurrency,
} from "./command-queue.js";
import {
  dequeueLaneQueue,
  enqueueLaneQueue,
  getLaneState,
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
  const queue = observe(getLaneState(`cancellation-work:${count}`).queue);
  const entries = Array.from({ length: count }, (_, index) => observe(makeEntry(index)));
  entries.forEach((entry) => enqueueLaneQueue(queue, entry));
  operations = 0;
  const removed = entries.toReversed().filter((entry) => removeLaneQueueEntry(queue, entry)).length;
  const cancellationOperations = operations;
  expect(removed).toBe(count);
  expect(queue.length).toBe(0);
  expect(peekLaneQueue(queue)).toBeUndefined();
  return cancellationOperations;
}

beforeEach(resetCommandQueueStateForTest);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetCommandQueueStateForTest();
});

it("admits aging work in FIFO order while foreground arrivals continue", async () => {
  vi.useFakeTimers();
  const lane = "main";
  setConcurrency(lane, 0);
  const starts: Array<[string, number]> = [];
  const pending: Promise<unknown>[] = [];
  const add = (priority: "background" | "normal" | "foreground", task: () => Promise<void>) =>
    pending.push(enqueue(lane, task, { priority }));
  for (const priority of ["background", "normal"] as const) {
    for (let index = 0; index < 2; index += 1) {
      add(priority, async () => void starts.push([`${priority}-${index}`, performance.now()]));
    }
  }
  const foregroundDone = createDeferred();
  const foreground = (index: number) => {
    add("foreground", async () => {
      starts.push(["foreground", performance.now()]);
      vi.advanceTimersByTime(1_000);
      // Wall-clock corrections must not extend priority's head start.
      vi.setSystemTime(Date.now() - 2_000);
      if (index < 39) {
        foreground(index + 1);
      } else {
        foregroundDone.resolve();
      }
    });
  };
  foreground(0);
  setConcurrency(lane, 1);
  await foregroundDone.promise;
  await Promise.all(pending);
  expect(starts[0]).toEqual(["foreground", 0]);
  expect(starts.filter(([kind]) => kind !== "foreground")).toEqual([
    ["normal-0", 15_000],
    ["normal-1", 15_000],
    ["background-0", 30_000],
    ["background-1", 30_000],
  ]);
  expect(starts.at(-1)).toEqual(["foreground", 39_000]);
});

it("preserves priority and FIFO after cancelling heads, middle entries and tails", async () => {
  const lane = "cancellation-order";
  setConcurrency(lane, 0);
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
        promise: enqueue(
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
  expect(snapshot(lane).queuedCount).toBe(3);
  const refills = priorities.map((priority) =>
    enqueue(lane, async () => void order.push(`${priority}-refill`), { priority }),
  );
  setConcurrency(lane, 1);
  const settled = await outcomes;
  await Promise.all(refills);
  expect(settled).toEqual(
    pending.map((entry) =>
      entry.index === 1
        ? { status: "fulfilled", value: entry.label }
        : { status: "rejected", reason },
    ),
  );
  expect(order).toEqual(
    priorities.toReversed().flatMap((priority) => [`${priority}-1`, `${priority}-refill`]),
  );
  expect(snapshot(lane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
});

it("does not search a shared signal for once-listeners that already fired", async () => {
  const lane = "cancellation-shared-signal";
  setConcurrency(lane, 0);
  const controller = new AbortController();
  const task = vi.fn(async () => "unexpected");
  const pending = Array.from({ length: 8 }, () =>
    enqueue(lane, task, { abortSignal: controller.signal }),
  );
  const outcomes = Promise.allSettled(pending);
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const reason = new Error("shared owner stopped");
  controller.abort(reason);
  expect(removeListener).not.toHaveBeenCalled();
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(await outcomes).toEqual(pending.map(() => ({ status: "rejected", reason })));
  expect(task).not.toHaveBeenCalled();
  expect(snapshot(lane).queuedCount).toBe(0);
  setConcurrency(lane, 1);
  await expect(enqueue(lane, async () => "refilled")).resolves.toBe("refilled");
});

it("detaches queued cancellation on admission and abort without cancelling active work", async () => {
  const lane = "cancellation-admission";
  const controller = new AbortController();
  const gate = createDeferred<string>();
  const active = enqueue(lane, async () => await gate.promise, {
    abortSignal: controller.signal,
  });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  const queued = enqueue(lane, async () => "unexpected", {
    abortSignal: controller.signal,
  });
  const reason = new Error("owner stopped queued work");
  const rejection = expect(queued).rejects.toBe(reason);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort(reason);
  expect(snapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 0 });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  gate.resolve("active finished");
  await rejection;
  await expect(active).resolves.toBe("active finished");
});

it("owner cancellation retains active capacity until raw settlement without disturbing siblings", async () => {
  const lane = "owner-cancellation";
  const otherLane = "owner-cancellation-sibling";
  setConcurrency(lane, 1);
  setConcurrency(otherLane, 1);
  const blocker = createDeferred();
  const otherBlocker = createDeferred();
  const cancellation = new AbortController();
  const first = enqueue(
    lane,
    async () => {
      await blocker.promise;
      return "first";
    },
    { abortSignal: cancellation.signal },
  );
  const other = enqueue(otherLane, async () => {
    await otherBlocker.promise;
    return "other";
  });
  const next = vi.fn(async () => "second");
  const second = enqueue(lane, next);
  expect(next).not.toHaveBeenCalled();
  expect(snapshot(lane).activeCount + snapshot(otherLane).activeCount).toBe(2);
  cancellation.abort(new Error("owner requested stop"));
  expect(snapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
  expect(next).not.toHaveBeenCalled();
  blocker.resolve();
  await expect(first).resolves.toBe("first");
  await expect(second).resolves.toBe("second");
  expect(next).toHaveBeenCalledOnce();
  expect(getQueueSize(lane)).toBe(0);
  expect(getQueueSize(otherLane)).toBe(1);
  otherBlocker.resolve();
  await expect(other).resolves.toBe("other");
});

it("releases entry references before reentrant cancellation cleanup", () => {
  const queue = getLaneState("reentrant-cancellation").queue;
  const entries = [makeEntry(0), makeEntry(1), makeEntry(2)];
  for (const entry of entries) {
    enqueueLaneQueue(queue, entry);
  }
  const removed = entries[1]!;
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
  expect(removeLaneQueueEntry(queue, removed)).toBe(true);
  expect(release).toHaveBeenCalledOnce();
  expect(Array.from({ length: 3 }, () => dequeueLaneQueue(queue))).toEqual([
    entries[0],
    entries[2],
    refill,
  ]);
  expect(dequeueLaneQueue(queue)).toBeUndefined();
  enqueueLaneQueue(queue, makeEntry(4));
  expect(dequeueLaneQueue(queue)?.sequence).toBe(4);
  expect(queue.length).toBe(0);
});

it("keeps total cancellation work linear as a backlog doubles", () => {
  const smaller = measureCancellationWork(128);
  const larger = measureCancellationWork(256);
  expect(larger).toBeLessThan(smaller * 3);
});
