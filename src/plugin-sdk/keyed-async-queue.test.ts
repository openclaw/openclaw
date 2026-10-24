import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { enqueueKeyedTask, KeyedAsyncQueue } from "./keyed-async-queue.js";

it.each(["function", "class"])("%s queue serializes per key and preserves results", async (api) => {
  const tails = new Map<string, Promise<void>>();
  const queue = new KeyedAsyncQueue();
  const enqueue = <T>(key: string, task: () => Promise<T>) =>
    api === "class" ? queue.enqueue(key, task) : enqueueKeyedTask({ tails, key, task });
  const gate = createDeferred();
  const order: string[] = [];
  const record = async (name: string, value: number, wait?: Promise<unknown>) => {
    order.push(`${name}:start`);
    if (wait) {
      await wait;
    }
    order.push(`${name}:end`);
    return value;
  };
  const first = enqueue("a", () => record("a1", 1, gate.promise));
  const second = enqueue("a", () => record("a2", 2));
  const third = enqueue("b", () => record("b1", 3));
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["a1:start", "b1:start", "b1:end"]);
  gate.resolve();
  await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
  expect(order).toEqual(["a1:start", "b1:start", "b1:end", "a1:end", "a2:start", "a2:end"]);
  expect(tails.size).toBe(0);
});

it("does not leak unhandled rejections when a task failure is already awaited", async () => {
  const tails = new Map<string, Promise<void>>();
  const enqueue = <T>(task: () => Promise<T>) => enqueueKeyedTask({ tails, key: "a", task });
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await expect(
      enqueue(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unhandled).toStrictEqual([]);
    await expect(enqueue(async () => "ok")).resolves.toBe("ok");
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

it("reserves overlapping object keys while their predecessors are still waiting", async () => {
  const tails = new WeakMap<object, Promise<void>>();
  const left = {},
    shared = {},
    right = {};
  const gate = createDeferred();
  const order: string[] = [];
  const enqueue = (keys: object[], name: string, wait?: Promise<unknown>) =>
    enqueueKeyedTask({
      tails,
      keys,
      task: async () => {
        order.push(name);
        if (wait) {
          await wait;
        }
      },
    });
  const first = enqueue([left, shared], "first", gate.promise);
  const second = enqueue([shared, right], "second");
  const third = enqueueKeyedTask({
    tails,
    key: right,
    task: async () => {
      order.push("third");
    },
  });
  try {
    await enqueue([{}], "independent");
    expect(order).toEqual(["first", "independent"]);
  } finally {
    gate.resolve();
    await Promise.all([first, second, third]);
  }
  expect(order).toEqual(["first", "independent", "second", "third"]);
});

it("runs enqueue/settle hooks once per task", async () => {
  const onEnqueue = vi.fn(),
    onSettle = vi.fn();
  await enqueueKeyedTask({
    tails: new Map<string, Promise<void>>(),
    key: "a",
    task: async () => undefined,
    hooks: { onEnqueue, onSettle },
  });
  expect(onEnqueue).toHaveBeenCalledTimes(1);
  expect(onSettle).toHaveBeenCalledTimes(1);
});

it("retains the deprecated tail-map accessor for Plugin SDK compatibility", () => {
  expect(new KeyedAsyncQueue().getTailMapForTesting()).toBeInstanceOf(Map);
});
