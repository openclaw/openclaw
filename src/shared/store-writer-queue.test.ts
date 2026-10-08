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

function createQueue(storePath = "store") {
  const queues = new Map<string, StoreWriterQueue>();
  const write = <T>(
    label: string,
    fn: () => Promise<T>,
    options: Omit<
      Parameters<typeof runQueuedStoreWrite<T>>[0],
      "queues" | "storePath" | "label" | "fn"
    > = {},
  ) => runQueuedStoreWrite({ queues, storePath, label, fn, ...options });
  return { queues, write };
}

beforeEach(async () => {
  await nextTurn();
});

it("marks synchronous idle and reentrant execution across runtime chunks", async () => {
  const sibling = await importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    "./store-writer-queue.js?scope=store-writer-timing",
  );
  const { queues, write } = createQueue();
  const outerTiming: StoreWriterTiming = {};
  const innerTiming: StoreWriterTiming = {};
  const order: string[] = [];
  let clock = 0;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const pending = write(
    "outer",
    async () => {
      order.push("outer:start");
      clock = 5;
      const inner = sibling.runQueuedStoreWrite({
        queues,
        storePath: "store",
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
      order.push("outer:end");
      clock = 15;
      return result;
    },
    { timing: outerTiming },
  );
  try {
    expect(order).toEqual(["outer:start", "inner"]);
    expect(outerTiming.startedAt).toBe(0);
    expect(await pending).toBe("result");
    expect(order).toEqual(["outer:start", "inner", "outer:end"]);
    expect(innerTiming).toEqual({ startedAt: 5, finishedAt: 10, reentrant: true });
    expect(outerTiming).toEqual({ startedAt: 0, finishedAt: 15, reentrant: false });
    expect(queues.size).toBe(0);
  } finally {
    await pending.catch(() => {});
    clockSpy.mockRestore();
  }
});

it.each([
  { outcome: "fulfilled", cost: 0 },
  { outcome: "rejected", cost: 0 },
  { outcome: "rejected-undefined", cost: 0 },
  { outcome: "fulfilled", cost: 10 },
] as const)("shares a bounded turn with I/O: $outcome, cost $cost", async ({ outcome, cost }) => {
  const { queues, write } = createQueue();
  const gate = createDeferred();
  const order: number[] = [];
  const failed = outcome !== "fulfilled";
  const failure =
    outcome === "rejected-undefined" ? undefined : new Error("synthetic writer failure");
  const rejectWrite = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const first = write("held-first", async () => gate.promise);
  const writes = Array.from({ length: 8 }, (_, index) =>
    write("queued", async () => {
      order.push(index);
      now += cost;
      return failed ? rejectWrite() : index;
    }),
  );
  const settled = Promise.allSettled(writes);
  const ioProgress = nextTurn().then(() => order.length);
  gate.resolve();
  try {
    const completedAtIoTurn = await ioProgress;
    await first;
    expect(completedAtIoTurn).toBeGreaterThan(0);
    expect(completedAtIoTurn).toBeLessThan(writes.length);
    if (cost) {
      expect(completedAtIoTurn).toBe(1);
      expect(await Promise.all(writes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
    expect(await settled).toEqual(
      Array.from({ length: 8 }, (_, value) =>
        failed ? { status: "rejected", reason: failure } : { status: "fulfilled", value },
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
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
    return [
      enqueue({ queues, storePath, label: "held-first", fn: async () => gate.promise }),
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

it("admits disjoint keys without bypassing an earlier overlapping waiter", async () => {
  vi.useFakeTimers();
  const { write } = createQueue();
  const releaseFirst = createDeferred();
  const joinedEntered = createDeferred();
  const releaseJoined = createDeferred();
  const order: string[] = [];
  const enqueue = (keys: string[], name: string, run: () => Promise<void>) =>
    write(
      name,
      async () => {
        order.push(name);
        await run();
      },
      { keys },
    );
  const first = enqueue(["a"], "first", () => releaseFirst.promise);
  const joined = enqueue(["a", "b"], "joined", async () => {
    joinedEntered.resolve();
    await releaseJoined.promise;
  });
  const follower = enqueue(["b"], "follower", async () => {});
  const independent = enqueue(["c"], "independent", async () => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["first", "independent"]);
    releaseFirst.resolve();
    await joinedEntered.promise;
    expect(order).toEqual(["first", "independent", "joined"]);
    releaseJoined.resolve();
    await Promise.all([first, joined, follower]);
    expect(order).toEqual(["first", "independent", "joined", "follower"]);
  } finally {
    releaseFirst.resolve();
    releaseJoined.resolve();
    await Promise.allSettled([first, joined, follower, independent]);
    vi.useRealTimers();
  }
});

it("holds a full-store barrier until every keyed writer settles and excludes later keys", async () => {
  const { write } = createQueue();
  const gates = [
    { key: "a", entered: createDeferred(), release: createDeferred() },
    { key: "b", entered: createDeferred(), release: createDeferred() },
  ] as const;
  const barrierEntered = createDeferred();
  const releaseBarrier = createDeferred();
  const order: string[] = [];
  const writers = gates.map(({ key, entered, release }) =>
    write(
      key,
      async () => {
        entered.resolve();
        await release.promise;
        order.push(key);
      },
      { keys: [key] },
    ),
  );
  const barrier = write("barrier", async () => {
    order.push("barrier");
    barrierEntered.resolve();
    await releaseBarrier.promise;
  });
  const later = write(
    "later",
    async () => {
      order.push("later");
    },
    { keys: ["c"] },
  );
  try {
    await Promise.all(gates.map(({ entered }) => entered.promise));
    gates[0].release.resolve();
    await writers[0];
    expect(order).toEqual(["a"]);
    gates[1].release.resolve();
    await barrierEntered.promise;
    expect(order).toEqual(["a", "b", "barrier"]);
    releaseBarrier.resolve();
    await Promise.all([...writers, barrier, later]);
    expect(order).toEqual(["a", "b", "barrier", "later"]);
  } finally {
    for (const { release } of gates) {
      release.resolve();
    }
    releaseBarrier.resolve();
    await Promise.allSettled([...writers, barrier, later]);
  }
});

it.each([false, true])(
  "cancels waiting writers but retains caller context, active settlement and FIFO (keyed: %s)",
  async (keyed) => {
    const contexts = new AsyncLocalStorage<string>();
    const { queues, write } = createQueue();
    const release = createDeferred();
    const activeController = new AbortController();
    const waitingController = new AbortController();
    const denied = new Error("writer revoked before admission");
    const order: string[] = [];
    const keys = keyed ? ["a"] : undefined;
    const enqueue = (owner: string, wait: Promise<void>, signal?: AbortSignal, writerKeys = keys) =>
      contexts.run(owner, () =>
        write(
          owner,
          async () => {
            order.push(owner);
            await wait;
            const context = await write("retained-owner", async () => contexts.getStore(), {
              keys: writerKeys,
              reentrant: true,
            });
            expect(context).toBe(owner);
            if (owner === "active") {
              order.push("settled");
              return "committed";
            }
            return context;
          },
          { keys: writerKeys, signal },
        ),
      );
    const active = enqueue("active", release.promise, activeController.signal);
    const canceled = enqueue(
      "canceled",
      Promise.resolve(),
      waitingController.signal,
      keyed ? ["a", "b"] : undefined,
    );
    const outcome = canceled.catch((error: unknown) => error);
    const independent = keyed
      ? enqueue("independent", Promise.resolve(), undefined, ["b"])
      : undefined;
    const followers = ["first", "second"].map((name) => enqueue(name, Promise.resolve()));
    try {
      activeController.abort(denied);
      waitingController.abort(denied);
      expect(await Promise.race([outcome, nextTurn().then(() => "still queued")])).toBe(denied);
      await expect(enqueue("forbidden", Promise.resolve(), waitingController.signal)).rejects.toBe(
        denied,
      );
      if (independent) {
        await expect(independent).resolves.toBe("independent");
      }
      expect(order).toEqual(keyed ? ["active", "independent"] : ["active"]);
      release.resolve();
      await expect(active).resolves.toBe("committed");
      await expect(Promise.all(followers)).resolves.toEqual(["first", "second"]);
      expect(order).toEqual(
        keyed
          ? ["active", "independent", "settled", "first", "second"]
          : ["active", "settled", "first", "second"],
      );
      expect(queues.size).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([active, canceled, independent, ...followers]);
    }
  },
);

it("reenters only keys covered by the active writer", async () => {
  const { write } = createQueue();
  const expanded = vi.fn(async () => {});
  const value = await write(
    "outer",
    async () => {
      const nested = await write("covered", async () => "covered", {
        keys: ["a"],
        reentrant: true,
      });
      for (const keys of [["a", "c"], undefined]) {
        await expect(write("expanded", expanded, { keys, reentrant: true })).rejects.toThrow(
          "Cannot expand an active store writer's keys",
        );
      }
      return nested;
    },
    { keys: ["a", "b"] },
  );
  expect(value).toBe("covered");
  expect(expanded).not.toHaveBeenCalled();
});

it("queues ordinary nested writes behind the active writer", async () => {
  const { queues, write } = createQueue();
  const releaseOuter = createDeferred();
  const order: string[] = [];
  let nested: Promise<unknown> | undefined;
  const outer = write("outer", async () => {
    order.push("outer:start");
    nested = write("inner", async () => {
      order.push("inner");
      return "inner-result";
    });
    await releaseOuter.promise;
    order.push("outer:end");
    return "outer-result";
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

it.each(["clear", "drain"] as const)(
  "%s cleanup preserves active ownership and discards rejected waiters",
  async (mode) => {
    const { queues, write } = createQueue();
    const gate = createDeferred();
    const active = write("active", () => gate.promise);
    const pendingWriter = vi.fn(async () => undefined);
    const pending = write("pending", pendingWriter);
    const activeDrain = queues.get("store")?.drainPromise;
    const rejected = expect(pending).rejects.toThrow("test cleanup");
    const cleanup =
      mode === "clear"
        ? Promise.resolve(clearStoreWriterQueuesForTest(queues, "test cleanup"))
        : drainStoreWriterQueuesForTest(queues, "test cleanup");
    let laterStarted = false;
    const later =
      mode === "clear"
        ? write("later", async () => {
            laterStarted = true;
          })
        : undefined;
    try {
      // A fresh lane would admit this writer while the active one still owns the store.
      expect(laterStarted).toBe(false);
      expect(activeDrain).toBeInstanceOf(Promise);
      await rejected;
      expect(pendingWriter).not.toHaveBeenCalled();
      gate.resolve();
      await Promise.all([active, activeDrain, cleanup, later]);
      expect(pendingWriter).not.toHaveBeenCalled();
      expect(laterStarted).toBe(mode === "clear");
      expect(queues.size).toBe(0);
    } finally {
      gate.resolve();
      await Promise.allSettled([active, pending, activeDrain, cleanup, later]);
    }
  },
);
