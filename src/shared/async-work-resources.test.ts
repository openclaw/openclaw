import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { runWithAsyncWorkResources } from "./async-work-resources.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "./async-work-scope.js";
import { createDeferredCore } from "./deferred.js";

describe("async work resources", () => {
  it.each([
    { eager: true, fails: false },
    { eager: true, fails: true },
    { eager: false, fails: true },
  ])("releases idle resources once (eager=$eager, fails=$fails)", async ({ eager, fails }) => {
    const owner = new AsyncWorkScope();
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const failure = new Error("resource cleanup failed");
    const release = vi.fn(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
      if (fails) {
        throw failure;
      }
    });
    let returned = false;
    const result = owner
      .run(() =>
        runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({ release, releaseBeforeResultWhenIdle: eager ? true : undefined });
          return "completed";
        }),
      )
      .then((value) => {
        returned = true;
        return value;
      });
    const outcome =
      eager && fails
        ? expect(result).rejects.toBe(failure)
        : expect(result).resolves.toBe("completed");
    try {
      await cleanupStarted.promise;
      await nextTurn();
      expect(returned).toBe(!eager);
      if (!eager) {
        expect(await result).toBe("completed");
        expect(owner.hasPendingWork).toBe(true);
      }
      expect(release).toHaveBeenCalledOnce();
    } finally {
      finishCleanup.resolve();
      await owner.drain();
    }
    await outcome;
    if (!eager) {
      expect(await result).toBe("completed");
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates cancellation immediately while accepted work retains cleanup", async () => {
    const owner = new AsyncWorkScope();
    const finishAdmission = createDeferredCore();
    const release = vi.fn();
    let operationSignal: AbortSignal | undefined;
    const result = owner.run(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({ release, releaseBeforeResultWhenIdle: true });
        operationSignal = getAsyncWorkSignal();
        void trackAsyncWork(() => finishAdmission.promise);
        return "enqueued";
      }),
    );
    try {
      expect(await result).toBe("enqueued");
      expect(owner.hasPendingWork).toBe(true);
      expect(release).not.toHaveBeenCalled();
      expect(operationSignal?.aborted).toBe(false);
      const reason = new Error("requester cancelled");
      owner.beginClose(reason);
      expect(operationSignal?.aborted).toBe(true);
      expect(operationSignal?.reason).toBe(reason);
      expect(release).not.toHaveBeenCalled();
      expect(owner.hasPendingWork).toBe(true);
    } finally {
      finishAdmission.resolve();
      await owner.drain();
    }
    expect(release).toHaveBeenCalledOnce();
  });
});
