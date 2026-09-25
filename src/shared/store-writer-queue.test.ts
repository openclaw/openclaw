// Verifies queue ownership and reentrancy across separately loaded runtime chunks.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred, drainStoreWriterQueuesForTest } from "../../test/helpers/promise.js";
import {
  runQueuedStoreWrite,
  clearStoreWriterQueuesForTest,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "./store-writer-queue.js";

beforeEach(async () => {
  await nextTurn();
});

it("marks idle and reentrant execution without deferring either callback", async () => {
  const queues = new Map<string, StoreWriterQueue>();
  const outerTiming: StoreWriterTiming = {};
  const innerTiming: StoreWriterTiming = {};
  const order: string[] = [];
  let clock = 0;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const pending = runQueuedStoreWrite({
    queues,
    storePath: "timed-store",
    label: "outer",
    timing: outerTiming,
    fn: async () => {
      order.push("outer");
      clock = 5;
      const inner = runQueuedStoreWrite({
        queues,
        storePath: "timed-store",
        label: "inner",
        reentrant: true,
        timing: innerTiming,
        fn: async () => {
          order.push("inner");
          clock = 10;
          return "result";
        },
      });
      expect(innerTiming.startedAt).toBe(5);
      const result = await inner;
      clock = 15;
      return result;
    },
  });
  try {
    expect(order).toEqual(["outer", "inner"]);
    expect(outerTiming.startedAt).toBe(0);
    expect(await pending).toBe("result");
    expect(innerTiming).toEqual({ startedAt: 5, finishedAt: 10, reentrant: true });
    expect(outerTiming).toEqual({ startedAt: 0, finishedAt: 15, reentrant: false });
    expect(queues.size).toBe(0);
  } finally {
    await pending.catch(() => {});
    clockSpy.mockRestore();
  }
});

it.each(["fulfilled", "rejected", "rejected-undefined"] as const)(
  "shares a bounded turn across ready writers while serving I/O (outcome: %s)",
  async (outcome) => {
    const queues = new Map<string, StoreWriterQueue>();
    const gate = createDeferred();
    const order: number[] = [];
    const failed = outcome !== "fulfilled";
    const failure =
      outcome === "rejected-undefined" ? undefined : new Error("synthetic writer failure");
    const rejectWrite = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const first = runQueuedStoreWrite({
      queues,
      storePath: "fair-store",
      label: "held-first",
      fn: async () => await gate.promise,
    });
    const writes = Array.from({ length: 8 }, (_, index) =>
      runQueuedStoreWrite({
        queues,
        storePath: "fair-store",
        label: "queued",
        fn: async () => {
          order.push(index);
          if (failed) {
            return rejectWrite();
          }
          return index;
        },
      }),
    );
    const settled = Promise.allSettled(writes);
    const ioProgress = nextTurn().then(() => order.length);
    gate.resolve();
    try {
      const completedAtIoTurn = await ioProgress;
      await first;
      const results = await settled;

      expect(completedAtIoTurn).toBeGreaterThan(0);
      expect(completedAtIoTurn).toBeLessThan(writes.length);
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(results).toEqual(
        order.map((value) =>
          failed ? { status: "rejected", reason: failure } : { status: "fulfilled", value },
        ),
      );
      expect(queues.size).toBe(0);
    } finally {
      await first;
      await settled;
      clock.mockRestore();
    }
  },
);

it("yields after one expensive ready writer before running its successors", async () => {
  const queues = new Map<string, StoreWriterQueue>();
  const gate = createDeferred();
  const order: number[] = [];
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const first = runQueuedStoreWrite({
    queues,
    storePath: "expensive-store",
    label: "held-first",
    fn: async () => gate.promise,
  });
  const writes = Array.from({ length: 8 }, (_, index) =>
    runQueuedStoreWrite({
      queues,
      storePath: "expensive-store",
      label: "ready",
      fn: async () => {
        order.push(index);
        now += 10;
        return index;
      },
    }),
  );
  const settled = Promise.all(writes);
  const ioProgress = nextTurn().then(() => order.length);
  gate.resolve();
  try {
    expect(await ioProgress).toBe(1);
    expect(await settled).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(queues.size).toBe(0);
  } finally {
    await first;
    await settled;
    clock.mockRestore();
  }
});

it("keeps I/O progressing across store backlogs in separate runtime chunks", async () => {
  const sibling = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=shared-turn-budget",
  );
  const queues = new Map<string, StoreWriterQueue>();
  const gate = createDeferred();
  const orders = Array.from({ length: 8 }, () => [] as number[]);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  let completed = 0;
  let done = false;
  const batches: number[] = [];
  const writers = orders.flatMap((order, store) => {
    const enqueue = store % 2 === 0 ? runQueuedStoreWrite : sibling.runQueuedStoreWrite;
    const storePath = `fair-store-${store}`;
    const first = enqueue({
      queues,
      storePath,
      label: "held-first",
      fn: async () => gate.promise,
    });
    return [
      first,
      ...Array.from({ length: 8 }, (_, value) =>
        enqueue({
          queues,
          storePath,
          label: "queued",
          fn: async () => {
            order.push(value);
            completed++;
          },
        }),
      ),
    ];
  });
  const settled = Promise.all(writers).finally(() => {
    done = true;
  });
  const ioProgress = (async () => {
    let previous = 0;
    for (;;) {
      await nextTurn();
      batches.push(completed - previous);
      previous = completed;
      if (done) {
        break;
      }
    }
  })();
  gate.resolve();
  try {
    await settled;
    await ioProgress;
    // I/O must not wait for even one successor from every busy store at once.
    expect(Math.max(...batches)).toBeLessThan(orders.length);
    expect(completed).toBe(64);
    for (const order of orders) {
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
    expect(queues.size).toBe(0);
  } finally {
    await settled;
    await ioProgress;
    clock.mockRestore();
  }
});

it("retains each queued writer's caller context through async and reentrant work", async () => {
  const contexts = new AsyncLocalStorage<string>();
  const queues = new Map<string, StoreWriterQueue>();
  const gate = createDeferred();
  const write = (owner: string, wait: Promise<void>) =>
    contexts.run(owner, () =>
      runQueuedStoreWrite({
        queues,
        storePath: "shared-store",
        label: owner,
        fn: async () => {
          await wait;
          return runQueuedStoreWrite({
            queues,
            storePath: "shared-store",
            label: "reentrant",
            reentrant: true,
            fn: async () => contexts.getStore(),
          });
        },
      }),
    );
  const first = write("first-owner", gate.promise);
  const second = write("second-owner", Promise.resolve());
  gate.resolve();
  expect(await Promise.all([first, second])).toEqual(["first-owner", "second-owner"]);
  expect(queues.size).toBe(0);
});

it("cancels only waiting writers while retaining active settlement and follower FIFO", async () => {
  const queues = new Map<string, StoreWriterQueue>();
  const release = createDeferred();
  const activeController = new AbortController();
  const waitingController = new AbortController();
  const denied = new Error("writer revoked before admission");
  const calls: string[] = [];
  const write = (fn: () => Promise<string>, signal?: AbortSignal) =>
    runQueuedStoreWrite({ queues, storePath: "cancelable", label: "cancelable", fn, signal });
  const active = write(async () => {
    calls.push("active");
    await release.promise;
    calls.push("settled");
    return "committed";
  }, activeController.signal);
  const canceled = write(async () => {
    calls.push("canceled");
    return "forbidden";
  }, waitingController.signal);
  const outcome = canceled.catch((error: unknown) => error);
  const followers = ["first", "second"].map((name) =>
    write(async () => {
      calls.push(name);
      return name;
    }),
  );
  try {
    activeController.abort(denied);
    waitingController.abort(denied);
    expect(await Promise.race([outcome, nextTurn().then(() => "still queued")])).toBe(denied);
    await expect(write(async () => "forbidden", waitingController.signal)).rejects.toBe(denied);
    expect(calls).toEqual(["active"]);
    release.resolve();
    await expect(active).resolves.toBe("committed");
    await expect(Promise.all(followers)).resolves.toEqual(["first", "second"]);
    expect(calls).toEqual(["active", "settled", "first", "second"]);
  } finally {
    release.resolve();
    await Promise.allSettled([active, canceled, ...followers]);
  }
});

it("queues ordinary nested writes behind the active writer", async () => {
  const queues = new Map<string, StoreWriterQueue>();
  const releaseOuter = createDeferred();
  const order: string[] = [];
  let nested: Promise<unknown> | undefined;

  const outer = runQueuedStoreWrite({
    queues,
    storePath: "nested-store",
    label: "outer",
    fn: async () => {
      order.push("outer:start");
      nested = runQueuedStoreWrite({
        queues,
        storePath: "nested-store",
        label: "inner",
        fn: async () => {
          order.push("inner");
          return "inner-result";
        },
      });
      await releaseOuter.promise;
      order.push("outer:end");
      return "outer-result";
    },
  });

  try {
    await nextTurn();
    expect(order).toEqual(["outer:start"]);
  } finally {
    releaseOuter.resolve();
    await outer;
    await nested;
  }
  await expect(outer).resolves.toBe("outer-result");
  await expect(nested).resolves.toBe("inner-result");
  expect(order).toEqual(["outer:start", "outer:end", "inner"]);
  expect(queues.size).toBe(0);
});

it("shares reentrant writer context across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=store-writer-a",
  );
  const second = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=store-writer-b",
  );
  const queues = new Map<string, StoreWriterQueue>();
  const order: string[] = [];

  const result = await first.runQueuedStoreWrite({
    queues,
    storePath: "shared-store",
    label: "outer",
    fn: async () => {
      order.push("outer:start");
      const nested = await second.runQueuedStoreWrite({
        queues,
        storePath: "shared-store",
        label: "inner",
        reentrant: true,
        fn: async () => {
          order.push("inner");
          return "nested-result";
        },
      });
      order.push("outer:end");
      return nested;
    },
  });

  expect(result).toBe("nested-result");
  expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  expect(queues.size).toBe(0);
});

it.each(["clear", "drain"] as const)(
  "never invokes rejected pending writers after %s cleanup settles",
  async (mode) => {
    const queues = new Map<string, StoreWriterQueue>();
    const gate = createDeferred();
    const active = runQueuedStoreWrite({
      queues,
      storePath: "cleanup",
      label: "active",
      fn: () => gate.promise,
    });
    const pendingWriter = vi.fn(async () => undefined);
    const pending = runQueuedStoreWrite({
      queues,
      storePath: "cleanup",
      label: "pending",
      fn: pendingWriter,
    });
    const activeDrain = queues.get("cleanup")?.drainPromise;
    const rejected = expect(pending).rejects.toThrow("test cleanup");
    const cleanup =
      mode === "clear"
        ? Promise.resolve(clearStoreWriterQueuesForTest(queues, "test cleanup"))
        : drainStoreWriterQueuesForTest(queues, "test cleanup");
    try {
      expect(activeDrain).toBeInstanceOf(Promise);
      await rejected;
      expect(pendingWriter).not.toHaveBeenCalled();
      gate.resolve();
      await Promise.all([active, activeDrain, cleanup]);
      expect(pendingWriter).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await Promise.allSettled([active, pending, activeDrain, cleanup]);
    }
  },
);
