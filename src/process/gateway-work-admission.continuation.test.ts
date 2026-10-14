import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayDetachedWorkContinuation,
  runWithGatewayIndependentRootWorkContinuation,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

async function bindParent(kind: "absent" | "released", run: () => Promise<void>) {
  if (kind === "absent") {
    return run;
  }
  const parent = tryBeginGatewayRootWorkAdmission("original-request");
  if (!parent) {
    throw new Error("Expected an admitted fixture parent");
  }
  try {
    return await parent.run(async () => AsyncLocalStorage.bind(run));
  } finally {
    parent.release();
  }
}

it.each(["absent", "released"] as const)(
  "cancels suspended independent continuation with %s parent before later admission",
  async (parent) => {
    const work = new AsyncWorkScope();
    const run = vi.fn(async () => {});
    const invoke = await bindParent(parent, () =>
      work.track(() => runWithGatewayIndependentRootWorkContinuation(run, "queued-launch")),
    );
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const closed = new Error("Original callback owner closed");
    let outcome: "fulfilled" | "rejected" | undefined;
    let rejection: unknown;
    const completion = invoke().then(
      () => {
        outcome = "fulfilled";
      },
      (error: unknown) => {
        outcome = "rejected";
        rejection = error;
      },
    );
    try {
      expect(run).not.toHaveBeenCalled();
      work.beginClose(closed);
      await nextTurn();
      expect
        .soft(outcome, "owner cancellation must not wait for suspension expiry")
        .toBe("rejected");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      suspension?.release();
      await completion;
      expect(run).not.toHaveBeenCalled();
      expect(rejection).toMatchObject({ cause: closed });
    } finally {
      suspension?.release();
      await completion;
      await work.drain();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it("preserves synchronous required continuation from a live parent in a closing scope", async () => {
  const work = new AsyncWorkScope();
  const parent = tryBeginGatewayRootWorkAdmission("live-request");
  if (!parent) {
    throw new Error("Expected an admitted fixture parent");
  }
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  const finish = createDeferredCore();
  const run = vi.fn(async () => await finish.promise);
  work.beginClose(new Error("Request cleanup started"));
  const completion = parent.run(async () =>
    work.run(() => runWithGatewayIndependentRootWorkContinuation(run, "required-cleanup")),
  );
  try {
    expect(run).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(2);
    finish.resolve();
    await completion;
    expect(getActiveGatewayRootWorkCount()).toBe(1);
  } finally {
    finish.resolve();
    await completion;
    parent.release();
    suspension?.release();
    await work.drain();
  }
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it.each(["absent", "released"] as const)(
  "keeps detached fallback independent of its closed caller with %s parent",
  async (parent) => {
    const work = new AsyncWorkScope();
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    let detachedSignal: AbortSignal | undefined;
    const invoke = await bindParent(parent, () =>
      work.run(() =>
        runWithGatewayDetachedWorkContinuation(async () => {
          detachedSignal = getAsyncWorkSignal();
          entered.resolve();
          await finish.promise;
        }, "detached-followup"),
      ),
    );
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const completion = invoke();
    try {
      await work.drain();
      expect(detachedSignal).toBeUndefined();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      suspension?.release();
      await entered.promise;
      expect(detachedSignal).toBeDefined();
      expect(detachedSignal).not.toBe(work.signal);
      expect(detachedSignal?.aborted).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      suspension?.release();
      finish.resolve();
      await completion;
      await work.drain();
      await nextTurn();
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it("retains already-admitted independent continuation through actual completion", async () => {
  const work = new AsyncWorkScope();
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  let settled = false;
  const completion = work
    .track(() =>
      runWithGatewayIndependentRootWorkContinuation(async () => {
        entered.resolve();
        await finish.promise;
      }, "admitted-followup"),
    )
    .then(() => {
      settled = true;
    });
  try {
    await entered.promise;
    work.beginClose(new Error("Caller closed after admission"));
    await nextTurn();
    expect(settled).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
  } finally {
    finish.resolve();
    await completion;
    await work.drain();
  }
  expect(settled).toBe(true);
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});
