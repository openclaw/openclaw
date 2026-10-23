import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, drainStoreWriterQueuesForTest } from "../../test/helpers/promise.js";
import {
  assertStoreWriterReleased,
  runQueuedStoreWrite,
  clearStoreWriterQueuesForTest,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "./store-writer-queue.js";

const releases: (() => void)[] = [];
const ownedWork: Promise<unknown>[] = [];
function own<T>(promise: Promise<T>): Promise<T> {
  ownedWork.push(promise);
  void promise.catch(() => {});
  return promise;
}
function makeGate() {
  const deferred = createDeferred();
  releases.push(() => deferred.resolve());
  return deferred;
}
const siblingModule = (scope: string) =>
  importFreshModule<typeof import("./store-writer-queue.js")>(
    import.meta.url,
    `./store-writer-queue.js?scope=${scope}`,
  );
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  while (ownedWork.length) {
    await Promise.allSettled(ownedWork.splice(0));
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function createQueue(
  storePath = "store",
  queues = new Map<string, StoreWriterQueue>(),
  enqueue = runQueuedStoreWrite,
) {
  const order: string[] = [];
  const write = <T>(
    label: string,
    fn: () => Promise<T>,
    options: Omit<
      Parameters<typeof runQueuedStoreWrite<T>>[0],
      "queues" | "storePath" | "label" | "fn"
    > = {},
  ) => own(enqueue({ queues, storePath, label, fn, ...options }));
  const held = (label: string, keys?: string[], finish = false) => {
    const entered = makeGate(),
      release = makeGate();
    const pending = write(
      label,
      async () => {
        if (!finish) {
          order.push(label);
        }
        entered.resolve();
        await release.promise;
        if (finish) {
          order.push(label);
        }
      },
      { keys },
    );
    return { entered: entered.promise, release: () => release.resolve(), pending };
  };
  const record = (label: string, keys?: string[]) =>
    write(label, async () => void order.push(label), { keys });
  return { queues, write, record, held, order };
}

beforeEach(async () => {
  await nextTurn();
});

it.each(["outer", "inner"] as const)("guards only live %s writer ownership", async (target) => {
  const outer = createQueue(),
    inner = createQueue();
  const check = () =>
    assertStoreWriterReleased((target === "outer" ? outer : inner).queues, "close readers");
  let retained = check;
  const expectHeld = (held: boolean) =>
    held
      ? expect(retained).toThrow("while holding a store writer")
      : expect(retained).not.toThrow();
  await outer.write("outer", async () => {
    expectHeld(target === "outer");
    await inner.write("inner", async () => {
      retained = AsyncLocalStorage.bind(check);
      expectHeld(true);
    });
    expectHeld(target === "outer");
  });
  expectHeld(false);
});

it("marks synchronous idle and reentrant execution across runtime chunks", async () => {
  const sibling = await siblingModule("store-writer-timing");
  const { queues, write, order } = createQueue();
  const outerTiming: StoreWriterTiming = {};
  const innerTiming: StoreWriterTiming = {};
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const siblingWrite = createQueue("store", queues, sibling.runQueuedStoreWrite).write;
  const pending = write(
    "outer",
    async () => {
      order.push("outer:start");
      clock = 5;
      const inner = siblingWrite(
        "inner",
        async () => {
          order.push("inner");
          clock = 10;
          return "result";
        },
        { reentrant: true, timing: innerTiming },
      );
      expect(innerTiming.startedAt).toBe(5);
      const result = await inner;
      order.push("outer:end");
      clock = 15;
      return result;
    },
    { timing: outerTiming },
  );
  expect(order).toEqual(["outer:start", "inner"]);
  expect(outerTiming.startedAt).toBe(0);
  expect(await pending).toBe("result");
  expect(order).toEqual(["outer:start", "inner", "outer:end"]);
  expect(innerTiming).toEqual({ startedAt: 5, finishedAt: 10, reentrant: true });
  expect(outerTiming).toEqual({ startedAt: 0, finishedAt: 15, reentrant: false });
  expect(queues.size).toBe(0);
});

it.each([
  { outcome: "rejected-undefined", cost: 0 },
  { outcome: "fulfilled", cost: 10 },
] as const)("shares a bounded turn with I/O: $outcome, cost $cost", async ({ outcome, cost }) => {
  const { queues, write } = createQueue();
  const release = makeGate();
  const order: number[] = [];
  const failed = outcome !== "fulfilled";
  const rejectWrite = vi.fn<() => Promise<never>>().mockRejectedValue(undefined);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const first = write("held-first", async () => release.promise);
  const writes = Array.from({ length: 8 }, (_, index) =>
    write("queued", async () => {
      order.push(index);
      now += cost;
      return failed ? rejectWrite() : index;
    }),
  );
  const settled = Promise.allSettled(writes);
  const ioProgress = nextTurn().then(() => order.length);
  release.resolve();
  const completedAtIoTurn = await ioProgress;
  await first;
  expect(completedAtIoTurn).toBeGreaterThan(0);
  expect(completedAtIoTurn).toBeLessThan(writes.length);
  if (cost) {
    expect(completedAtIoTurn).toBe(1);
  }
  expect(await settled).toEqual(
    Array.from({ length: 8 }, (_, value) =>
      failed ? { status: "rejected", reason: undefined } : { status: "fulfilled", value },
    ),
  );
  expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(queues.size).toBe(0);
});

it("keeps I/O progressing across store backlogs in separate runtime chunks", async () => {
  const sibling = await siblingModule("shared-turn-budget");
  const queues = new Map<string, StoreWriterQueue>();
  const release = makeGate();
  const orders = Array.from({ length: 8 }, () => [] as number[]);
  vi.spyOn(performance, "now").mockReturnValue(0);
  let completed = 0;
  let done = false;
  const batches: number[] = [];
  const writers = orders.flatMap((order, store) => {
    const { write } = createQueue(
      `fair-store-${store}`,
      queues,
      store % 2 === 0 ? runQueuedStoreWrite : sibling.runQueuedStoreWrite,
    );
    return [
      write("held-first", async () => release.promise),
      ...Array.from({ length: 8 }, (_, value) =>
        write("queued", async () => {
          order.push(value);
          completed++;
        }),
      ),
    ];
  });
  const settled = Promise.all(writers).finally(() => {
    done = true;
  });
  const ioProgress = own(
    (async () => {
      let previous = 0;
      for (;;) {
        await nextTurn();
        batches.push(completed - previous);
        previous = completed;
        if (done) {
          break;
        }
      }
    })(),
  );
  release.resolve();
  await settled;
  await ioProgress;
  // I/O must not wait for even one successor from every busy store at once.
  expect(Math.max(...batches)).toBeLessThan(orders.length);
  expect(completed).toBe(64);
  for (const order of orders) {
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  }
  expect(queues.size).toBe(0);
});

it("admits disjoint keys without bypassing an earlier overlapping waiter", async () => {
  vi.useFakeTimers();
  const { record, held, order } = createQueue();
  const first = held("first", ["a"]);
  const joined = held("joined", ["a", "b"]);
  const follower = record("follower", ["b"]);
  const independent = record("independent", ["c"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(["first", "independent"]);
  first.release();
  await joined.entered;
  await independent;
  expect(order).toEqual(["first", "independent", "joined"]);
  joined.release();
  await Promise.all([first.pending, joined.pending, follower]);
  expect(order).toEqual(["first", "independent", "joined", "follower"]);
});

it("holds a full-store barrier until every keyed writer settles and excludes later keys", async () => {
  const { record, held, order } = createQueue();
  const writers = [held("a", ["a"], true), held("b", ["b"], true)] as const;
  const barrier = held("barrier");
  const later = record("later", ["c"]);
  await Promise.all(writers.map(({ entered }) => entered));
  writers[0].release();
  await writers[0].pending;
  expect(order).toEqual(["a"]);
  writers[1].release();
  await barrier.entered;
  expect(order).toEqual(["a", "b", "barrier"]);
  barrier.release();
  await Promise.all([...writers.map(({ pending }) => pending), barrier.pending, later]);
  expect(order).toEqual(["a", "b", "barrier", "later"]);
});

it.each([false, true])(
  "cancels waiting writers but retains caller context, active settlement and FIFO (keyed: %s)",
  async (keyed) => {
    const contexts = new AsyncLocalStorage<string>();
    const { queues, write, order } = createQueue();
    const release = makeGate();
    const activeController = new AbortController();
    const waitingController = new AbortController();
    const denied = new Error("writer revoked before admission");
    const keys = keyed ? ["a"] : undefined;
    const enqueue = (
      owner: string,
      signal?: AbortSignal,
      writerKeys = keys,
      wait = Promise.resolve(),
    ) =>
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
            }
            return owner === "active" ? "committed" : context;
          },
          { keys: writerKeys, signal },
        ),
      );
    const active = enqueue("active", activeController.signal, keys, release.promise);
    const canceled = enqueue("canceled", waitingController.signal, keyed ? ["a", "b"] : undefined);
    const outcome = canceled.catch((error: unknown) => error);
    const independent = keyed ? enqueue("independent", undefined, ["b"]) : undefined;
    const followers = ["first", "second"].map((name) => enqueue(name));
    activeController.abort(denied);
    waitingController.abort(denied);
    expect(await Promise.race([outcome, nextTurn().then(() => "still queued")])).toBe(denied);
    await expect(enqueue("forbidden", waitingController.signal)).rejects.toBe(denied);
    if (independent) {
      await expect(independent).resolves.toBe("independent");
    }
    const admitted = keyed ? ["active", "independent"] : ["active"];
    expect(order).toEqual(admitted);
    release.resolve();
    await expect(active).resolves.toBe("committed");
    await expect(Promise.all(followers)).resolves.toEqual(["first", "second"]);
    expect(order).toEqual([...admitted, "settled", "first", "second"]);
    expect(queues.size).toBe(0);
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
  const { queues, write, order } = createQueue();
  const releaseOuter = makeGate();
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
  await nextTurn();
  expect(order).toEqual(["outer:start"]);
  releaseOuter.resolve();
  await expect(Promise.all([outer, nested])).resolves.toEqual(["outer-result", "inner-result"]);
  expect(order).toEqual(["outer:start", "outer:end", "inner"]);
  expect(queues.size).toBe(0);
});

it.each(["clear", "drain"] as const)(
  "%s cleanup preserves active ownership and discards rejected waiters",
  async (mode) => {
    const { queues, write } = createQueue();
    const gate = makeGate();
    const active = write("active", () => gate.promise);
    const pendingWriter = vi.fn(async () => undefined);
    const pending = write("pending", pendingWriter);
    const activeDrain = queues.get("store")?.drainPromise;
    const rejected = expect(pending).rejects.toThrow("test cleanup");
    const cleanup = own(
      mode === "clear"
        ? Promise.resolve(clearStoreWriterQueuesForTest(queues, "test cleanup"))
        : drainStoreWriterQueuesForTest(queues, "test cleanup"),
    );
    const laterWriter = vi.fn(async () => {});
    const later = mode === "clear" ? write("later", laterWriter) : undefined;
    // A fresh lane would admit this writer while the active one still owns the store.
    expect(laterWriter).not.toHaveBeenCalled();
    expect(activeDrain).toBeInstanceOf(Promise);
    await rejected;
    expect(pendingWriter).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([active, activeDrain, cleanup, later]);
    expect(pendingWriter).not.toHaveBeenCalled();
    expect(laterWriter).toHaveBeenCalledTimes(Number(mode === "clear"));
    expect(queues.size).toBe(0);
  },
);
