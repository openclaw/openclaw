import { describe, expect, it, vi } from "vitest";
import { enqueueKeyedTask, KeyedAsyncQueue } from "./keyed-async-queue.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("enqueueKeyedTask", () => {
  it("serializes tasks per key and keeps different keys independent", async () => {
    const tails = new Map<string, Promise<void>>();
    const gate = deferred<void>();
    const order: string[] = [];

    const first = enqueueKeyedTask({
      tails,
      key: "a",
      task: async () => {
        order.push("a1:start");
        await gate.promise;
        order.push("a1:end");
      },
    });
    const second = enqueueKeyedTask({
      tails,
      key: "a",
      task: async () => {
        order.push("a2:start");
        order.push("a2:end");
      },
    });
    const third = enqueueKeyedTask({
      tails,
      key: "b",
      task: async () => {
        order.push("b1:start");
        order.push("b1:end");
      },
    });

    await vi.waitFor(() => {
      expect(order).toContain("a1:start");
      expect(order).toContain("b1:start");
    });
    expect(order).not.toContain("a2:start");

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["a1:start", "b1:start", "b1:end", "a1:end", "a2:start", "a2:end"]);
    expect(tails.size).toBe(0);
  });

  it("keeps queue alive after task failures", async () => {
    const tails = new Map<string, Promise<void>>();
    await expect(
      enqueueKeyedTask({
        tails,
        key: "a",
        task: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    await expect(
      enqueueKeyedTask({
        tails,
        key: "a",
        task: async () => "ok",
      }),
    ).resolves.toBe("ok");
  });

  it("runs enqueue/settle hooks once per task", async () => {
    const tails = new Map<string, Promise<void>>();
    const onEnqueue = vi.fn();
    const onSettle = vi.fn();
    await enqueueKeyedTask({
      tails,
      key: "a",
      task: async () => undefined,
      hooks: { onEnqueue, onSettle },
    });
    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe("KeyedAsyncQueue", () => {
  it("exposes tail map for observability", async () => {
    const queue = new KeyedAsyncQueue();
    const gate = deferred<void>();
    const run = queue.enqueue("actor", async () => {
      await gate.promise;
      return 1;
    });
    expect(queue.getTailMapForTesting().has("actor")).toBe(true);
    gate.resolve();
    await run;
    await Promise.resolve();
    expect(queue.getTailMapForTesting().has("actor")).toBe(false);
  });
});
