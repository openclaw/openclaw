import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { runWithAsyncWorkResources } from "./async-work-resources.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "./async-work-scope.js";
import { createDeferredCore } from "./deferred.js";

describe("async work resources", () => {
  it("returns the default logical result while its owner still joins cleanup", async () => {
    const owner = new AsyncWorkScope();
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const release = vi.fn(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });
    const result = owner.run(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({ release });
        return "accepted";
      }),
    );
    try {
      expect(await result).toBe("accepted");
      await cleanupStarted.promise;
      expect(owner.hasPendingWork).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      finishCleanup.resolve();
      await owner.drain();
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases opted-in idle resources exactly once before returning the result", async () => {
    const owner = new AsyncWorkScope();
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const release = vi.fn(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });
    let returned = false;
    const result = owner
      .run(() =>
        runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({ release, releaseBeforeResultWhenIdle: true });
          return "completed";
        }),
      )
      .then((value) => {
        returned = true;
        return value;
      });
    try {
      await cleanupStarted.promise;
      await nextTurn();
      expect(returned).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      finishCleanup.resolve();
      await owner.drain();
    }
    expect(await result).toBe("completed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns an opted-in result while accepted work still owns its resources", async () => {
    const owner = new AsyncWorkScope();
    const finishAdmission = createDeferredCore();
    const release = vi.fn();
    const result = owner.run(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({ release, releaseBeforeResultWhenIdle: true });
        void trackAsyncWork(() => finishAdmission.promise);
        return "enqueued";
      }),
    );
    try {
      expect(await result).toBe("enqueued");
      expect(owner.hasPendingWork).toBe(true);
      expect(release).not.toHaveBeenCalled();
    } finally {
      finishAdmission.resolve();
      await owner.drain();
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects opted-in idle cleanup failures without attempting release twice", async () => {
    const owner = new AsyncWorkScope();
    const failure = new Error("resource cleanup failed");
    const release = vi.fn(async () => {
      throw failure;
    });
    const result = owner.run(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({ release, releaseBeforeResultWhenIdle: true });
        return "completed";
      }),
    );
    await expect(result).rejects.toBe(failure);
    await owner.drain();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not replace a default logical result when later cleanup fails", async () => {
    const owner = new AsyncWorkScope();
    const finishCleanup = createDeferredCore();
    const release = vi.fn(async () => {
      await finishCleanup.promise;
      throw new Error("resource cleanup failed");
    });
    const result = owner.run(() =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({ release });
        return "accepted";
      }),
    );
    try {
      expect(await result).toBe("accepted");
    } finally {
      finishCleanup.resolve();
      await owner.drain();
    }
    expect(await result).toBe("accepted");
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
