// Covers the one-shot wait for detached root work before databases close.
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  resetGatewayWorkAdmission,
  runAsGatewaySubscription,
  runWithGatewayDetachedWorkAdmission,
  waitForGatewayRootWorkIdle,
} from "./gateway-work-admission.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

it("returns at once with no detached work or only long-lived subscriptions", async () => {
  const waiting: number[] = [];
  await waitForGatewayRootWorkIdle({ onWaiting: (count) => waiting.push(count) });
  const listener = createDeferredCore();
  const subscription = runAsGatewaySubscription(() =>
    runWithGatewayDetachedWorkAdmission(() => listener.promise, "test:watcher"),
  );
  await waitForGatewayRootWorkIdle({ onWaiting: (count) => waiting.push(count) });
  expect(waiting).toEqual([]);
  listener.resolve();
  await subscription;
});

it("waits for detached work, reporting the count once", async () => {
  const waiting: number[] = [];
  const work = createDeferredCore();
  const detached = runWithGatewayDetachedWorkAdmission(() => work.promise, "test:completion");
  let idle = false;
  const waited = waitForGatewayRootWorkIdle({ onWaiting: (count) => waiting.push(count) }).then(
    () => {
      idle = true;
    },
  );
  await Promise.resolve();
  expect(waiting).toEqual([1]);
  expect(idle).toBe(false);
  work.resolve();
  await detached;
  await waited;
  expect(idle).toBe(true);
});

it("stops waiting when the user interrupts", async () => {
  const work = createDeferredCore();
  const detached = runWithGatewayDetachedWorkAdmission(() => work.promise, "test:stuck");
  const interrupt = new AbortController();
  const waited = waitForGatewayRootWorkIdle({ signal: interrupt.signal });
  interrupt.abort();
  await waited;
  work.resolve();
  await detached;
});
