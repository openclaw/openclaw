import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { BoundedSerialQueue } from "./bounded-serial-queue.js";

describe("BoundedSerialQueue", () => {
  it("retains each caller's async context across waits and failures", async () => {
    const context = new AsyncLocalStorage<string>();
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 2 });
    const observed: Array<string | undefined> = [];
    const failure = new Error("second failed");
    const one = context.run("first", () =>
      queue.enqueue(async () => {
        observed.push(context.getStore());
        await first.promise;
        observed.push(context.getStore());
      }),
    );
    const two = context.run("second", () =>
      queue.enqueue(async () => {
        observed.push(context.getStore());
        await Promise.resolve();
        observed.push(context.getStore());
        throw failure;
      }),
    );
    const three = queue.enqueue(() => observed.push(context.getStore()));
    expect(one.accepted && two.accepted && three.accepted).toBe(true);
    const rejected = expect(two.accepted ? two.completion : Promise.resolve()).rejects.toBe(
      failure,
    );
    first.resolve();
    await Promise.all([queue.flush(), rejected]);

    expect(observed).toEqual(["first", "first", "second", "second", undefined]);
    expect(context.getStore()).toBeUndefined();
    expect(queue.isIdle).toBe(true);
    const reused = context.run("reused", () => queue.enqueue(() => context.getStore()));
    expect(reused.accepted).toBe(true);
    if (reused.accepted) {
      await expect(reused.completion).resolves.toBe("reused");
    }
  });

  it("bounds waiting count and weight, then seals on the first overflow", () => {
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 5 });
    const active = queue.enqueue(async () => await first.promise, { weight: 100 });
    const waiting = queue.enqueue(async () => undefined, { weight: 3 });
    const overflow = queue.enqueue(async () => undefined, { weight: 3 });
    const late = queue.enqueue(async () => undefined);

    expect(active.accepted).toBe(true);
    expect(waiting.accepted).toBe(true);
    expect(overflow).toEqual({ accepted: false, reason: "overflow" });
    expect(late).toEqual({ accepted: false, reason: "sealed" });
    expect(queue.didOverflow).toBe(true);
    first.resolve();
  });

  it("can reject at capacity without sealing admission", async () => {
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
    const active = queue.enqueue(async () => await first.promise);
    const waiting = queue.enqueue(async () => undefined);

    expect(
      queue.enqueue(async () => undefined, {
        sealOnOverflow: false,
      }),
    ).toEqual({ accepted: false, reason: "capacity" });
    expect(queue.didOverflow).toBe(false);

    first.resolve();
    await queue.flush();
    const afterDrain = queue.enqueue(async () => "accepted");
    expect(afterDrain.accepted).toBe(true);
    if (afterDrain.accepted) {
      await expect(afterDrain.completion).resolves.toBe("accepted");
    }
    if (active.accepted) {
      await active.completion;
    }
    if (waiting.accepted) {
      await waiting.completion;
    }
  });

  it("flushes only the accepted prefix visible at call time", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 2 });
    const active = queue.enqueue(async () => await first.promise);
    const flush = queue.flush();
    expect(queue.flush()).toBe(flush);
    const late = queue.enqueue(async () => await second.promise);
    const flushed = vi.fn();
    void flush.then(flushed);

    first.resolve();
    await flush;

    expect(flushed).toHaveBeenCalledOnce();
    expect(late.accepted && queue.isIdle).toBe(false);
    second.resolve();
    await queue.flush();
    expect(queue.isIdle).toBe(true);
    if (active.accepted) {
      await active.completion;
    }
    if (late.accepted) {
      await late.completion;
    }
  });

  it.each([undefined])("preserves the first failure (%s) in a sealed prefix", async (failure) => {
    const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
    const first = createDeferred();
    const task = queue.enqueue(() => first.promise);
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
      expect(task.accepted ? task.completion : Promise.resolve()).rejects.toBe(failure),
      expect(later.accepted ? later.completion : Promise.resolve()).rejects.toBe(laterFailure),
    ]);
    expect(queue.isIdle).toBe(true);
  });

  it("does not reject a successful flush prefix for a later synchronous failure", async () => {
    const first = createDeferred();
    const queue = new BoundedSerialQueue({ maxPendingCount: 1, maxPendingWeight: 1 });
    const active = queue.enqueue(() => first.promise);
    const prefix = queue.flush({ requireSuccess: true });
    const failure = new Error("outside the captured prefix");
    const later = queue.enqueue(() => {
      throw failure;
    });
    const laterFailure = expect(later.accepted ? later.completion : Promise.resolve()).rejects.toBe(
      failure,
    );

    first.resolve();

    await Promise.all([expect(prefix).resolves.toBeUndefined(), laterFailure]);
    await expect(queue.flush({ requireSuccess: true })).rejects.toBe(failure);
    if (active.accepted) {
      await active.completion;
    }
    expect(queue.isIdle).toBe(true);
  });
});
