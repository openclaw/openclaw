import { expect, it } from "vitest";
import { createDeferredCore } from "./deferred.js";
import { createPendingPromiseTracker } from "./pending-promises.js";

it("retains original promises in their owner's set until either outcome settles", async () => {
  const pending = new Set<Promise<unknown>>();
  const separate = new Set<Promise<number>>();
  const track = createPendingPromiseTracker(pending);
  const trackSeparate = createPendingPromiseTracker(separate);
  const success = createDeferredCore<string>();
  const failure = createDeferredCore<number>();
  const other = createDeferredCore<number>();
  expect(track(success.promise)).toBe(success.promise);
  expect(track(failure.promise)).toBe(failure.promise);
  expect(trackSeparate(other.promise)).toBe(other.promise);
  expect([...pending]).toEqual([success.promise, failure.promise]);
  expect([...separate]).toEqual([other.promise]);

  success.resolve("done");
  await expect(success.promise).resolves.toBe("done");
  expect([...pending]).toEqual([failure.promise]);
  expect([...separate]).toEqual([other.promise]);

  const error = new Error("work failed");
  failure.reject(error);
  await expect(failure.promise).rejects.toBe(error);
  expect(pending.size).toBe(0);
  other.resolve(42);
  await expect(other.promise).resolves.toBe(42);
  expect(separate.size).toBe(0);
});
