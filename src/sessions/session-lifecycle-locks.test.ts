import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { StoreWriterQueue } from "../shared/store-writer-queue.js";
import { createSessionIdentityLockRunner } from "./session-lifecycle-locks.js";

it.each([5_000, 50_000])("acquires and releases %i identity locks", async (count) => {
  const state = {
    lifecycleQueues: new Map<string, StoreWriterQueue>(),
    mutationQueues: new Map<string, StoreWriterQueue>(),
  };
  const run = createSessionIdentityLockRunner(state);
  const identities = Array.from({ length: count }, (_, index) => `session-${index}`);
  for (const kind of ["lifecycle", "mutation"] as const) {
    await expect(
      run(identities, async () => "completed", undefined, undefined, kind),
    ).resolves.toBe("completed");
    expect(state.lifecycleQueues.size).toBe(0);
    expect(state.mutationQueues.size).toBe(0);
  }
});

it("retains bulk locks through contention, reentry, and failure", async () => {
  const state = {
    lifecycleQueues: new Map<string, StoreWriterQueue>(),
    mutationQueues: new Map<string, StoreWriterQueue>(),
  };
  const run = createSessionIdentityLockRunner(state);
  const identities = Array.from({ length: 5_000 }, (_, index) => `session-${index}`);
  const releaseBlocker = createDeferred();
  const blocker = run(["session-2500"], async () => await releaseBlocker.promise);
  const failure = new Error("bulk mutation failed");
  const order: string[] = [];
  const bulk = run(identities, async () => {
    await run(["session-0", "session-2500", "session-4999"], async () => {
      order.push("bulk");
    });
    throw failure;
  });
  const rejected = expect(bulk).rejects.toBe(failure);
  const successor = run(["session-0"], async () => {
    order.push("successor");
  });
  expect(order).toEqual([]);
  releaseBlocker.resolve();
  await Promise.all([blocker, rejected, successor]);
  expect(order).toEqual(["bulk", "successor"]);
  expect(state.lifecycleQueues.size).toBe(0);
});
