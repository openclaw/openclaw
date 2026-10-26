import { AsyncLocalStorage } from "node:async_hooks";
import { assert, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { BoundedSerialQueue } from "./bounded-serial-queue.js";

function completion<T>(
  admission: { accepted: true; completion: Promise<T> } | { accepted: false },
) {
  assert(admission.accepted, "Expected queue admission");
  return admission.completion;
}

function blockedQueue(count = 1, weight = count) {
  const first = createDeferred();
  const queue = new BoundedSerialQueue({ maxPendingCount: count, maxPendingWeight: weight });
  const active = queue.enqueue(() => first.promise);
  return { first, queue, active };
}

it("retains each caller's async context across waits and failures", async () => {
  const context = new AsyncLocalStorage<string>();
  const first = createDeferred();
  const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 2 });
  const observed: Array<string | undefined> = [];
  const failure = new Error("second failed");
  const observe = async (wait: Promise<unknown>) => {
    observed.push(context.getStore());
    await wait;
    observed.push(context.getStore());
  };
  const one = context.run("first", () => queue.enqueue(() => observe(first.promise)));
  const two = context.run("second", () =>
    queue.enqueue(async () => {
      await observe(Promise.resolve());
      throw failure;
    }),
  );
  const three = queue.enqueue(() => observed.push(context.getStore()));
  expect(one.accepted && two.accepted && three.accepted).toBe(true);
  const rejected = expect(completion(two)).rejects.toBe(failure);
  first.resolve();
  await Promise.all([queue.flush(), rejected]);

  expect(observed).toEqual(["first", "first", "second", "second", undefined]);
  expect(context.getStore()).toBeUndefined();
  expect(queue.isIdle).toBe(true);
  const reused = context.run("reused", () => queue.enqueue(() => context.getStore()));
  await expect(completion(reused)).resolves.toBe("reused");
});

it("bounds waiting count and weight, then seals on the first overflow", () => {
  const first = createDeferred();
  const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 5 });
  const active = queue.enqueue(async () => await first.promise, { weight: 100 });
  const waiting = queue.enqueue(async () => undefined, { weight: 3 });
  const overflow = queue.enqueue(async () => undefined, { weight: 3 });
  const late = queue.enqueue(async () => undefined);

  expect(active.accepted && waiting.accepted).toBe(true);
  expect(overflow).toEqual({ accepted: false, reason: "overflow" });
  expect(late).toEqual({ accepted: false, reason: "sealed" });
  expect(queue.didOverflow).toBe(true);
  first.resolve();
});

it("can reject at capacity without sealing admission", async () => {
  const { first, queue, active } = blockedQueue();
  const waiting = queue.enqueue(async () => undefined);

  expect(queue.enqueue(async () => undefined, { sealOnOverflow: false })).toEqual({
    accepted: false,
    reason: "capacity",
  });
  expect(queue.didOverflow).toBe(false);

  first.resolve();
  await queue.flush();
  const afterDrain = queue.enqueue(async () => "accepted");
  await expect(completion(afterDrain)).resolves.toBe("accepted");
  await Promise.all([completion(active), completion(waiting)]);
});

it("flushes only the accepted prefix visible at call time", async () => {
  const { first, queue, active } = blockedQueue(2);
  const second = createDeferred();
  const flush = queue.flush();
  expect(queue.flush()).toBe(flush);
  const late = queue.enqueue(async () => await second.promise);

  first.resolve();
  await flush;

  expect(late.accepted && queue.isIdle).toBe(false);
  second.resolve();
  await queue.flush();
  expect(queue.isIdle).toBe(true);
  await Promise.all([completion(active), completion(late)]);
});

it("preserves the first failure (undefined) in a sealed prefix", async () => {
  const failure = undefined;
  const { first, queue, active } = blockedQueue();
  const laterFailure = new Error("later failure");
  const later = queue.enqueue(() => {
    throw laterFailure;
  });
  queue.seal();
  const ordinaryFlush = queue.flush();
  const strictFlush = queue.flush({ requireSuccess: true });

  first.reject(failure);
  await Promise.all([
    expect(ordinaryFlush).resolves.toBeUndefined(),
    expect(strictFlush).rejects.toBe(failure),
    expect(completion(active)).rejects.toBe(failure),
    expect(completion(later)).rejects.toBe(laterFailure),
  ]);
  expect(queue.isIdle).toBe(true);
});

it("does not reject a successful flush prefix for a later synchronous failure", async () => {
  const { first, queue, active } = blockedQueue();
  const prefix = queue.flush({ requireSuccess: true });
  const failure = new Error("outside the captured prefix");
  const later = queue.enqueue(() => {
    throw failure;
  });
  const laterFailure = expect(completion(later)).rejects.toBe(failure);

  first.resolve();

  await Promise.all([expect(prefix).resolves.toBeUndefined(), laterFailure]);
  await expect(queue.flush({ requireSuccess: true })).rejects.toBe(failure);
  await completion(active);
  expect(queue.isIdle).toBe(true);
});
