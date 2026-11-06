import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayDetachedWorkContinuation as detached,
  runWithGatewayIndependentRootWorkContinuation as independent,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";

let work: AsyncWorkScope;
let finish: Deferred;
let entered: Deferred;
let completion: Promise<unknown>;
let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission>;
let callback: ReturnType<typeof vi.fn<() => Promise<void>>>;
let callbackSignal: AbortSignal | undefined;
const parentKinds = ["absent", "released"] as const;

beforeEach(() => {
  resetGatewayWorkAdmission();
  work = new AsyncWorkScope();
  finish = createDeferredCore();
  entered = createDeferredCore();
  completion = Promise.resolve();
  suspension = null;
  callbackSignal = undefined;
  callback = vi.fn(async () => {
    callbackSignal = getAsyncWorkSignal();
    entered.resolve();
    await finish.promise;
  });
});
afterEach(async () => {
  finish.resolve();
  suspension?.release();
  await completion;
  await work.drain();
  await nextTurn();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  resetGatewayWorkAdmission();
});

function suspend() {
  suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  return suspension;
}

async function bindParent(kind: "absent" | "released", run: () => Promise<void>) {
  if (kind === "absent") {
    return run;
  }
  const admission = tryBeginGatewayRootWorkAdmission("original-request");
  assert(admission, "Expected an admitted fixture parent");
  return admission.run(async () => AsyncLocalStorage.bind(run)).finally(admission.release);
}

it.each(parentKinds)("cancels suspended continuation (%s parent)", async (parent) => {
  const run = vi.fn(async () => {});
  const invoke = await bindParent(parent, () =>
    work.track(() => independent(run, "queued-launch")),
  );
  const suspended = suspend();
  const closed = new Error("Original callback owner closed");
  const rejected = vi.fn();
  completion = invoke().catch(rejected);
  expect(run).not.toHaveBeenCalled();
  work.beginClose(closed);
  await nextTurn();
  expect
    .soft(rejected, "owner cancellation must not wait for suspension expiry")
    .toHaveBeenCalledOnce();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  suspended?.release();
  await completion;
  expect(run).not.toHaveBeenCalled();
  expect(rejected.mock.calls[0]?.[0]).toMatchObject({ cause: closed });
});

it.each(parentKinds)("detaches fallback from a closed caller (%s parent)", async (parent) => {
  const invoke = await bindParent(parent, () =>
    work.run(() => detached(callback, "detached-followup")),
  );
  const suspended = suspend();
  completion = invoke();
  await work.drain();
  expect(callbackSignal).toBeUndefined();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  suspended?.release();
  await entered.promise;
  expect(callbackSignal).toMatchObject({ aborted: false });
  expect(callbackSignal).not.toBe(work.signal);
  expect(getActiveGatewayRootWorkCount()).toBe(1);
});
