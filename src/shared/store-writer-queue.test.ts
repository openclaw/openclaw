// Verifies queue ownership and reentrancy across separately loaded runtime chunks.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  runQueuedStoreWrite,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "./store-writer-queue.js";

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
