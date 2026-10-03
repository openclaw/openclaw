import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  markFollowupRunEnqueued,
  releaseBeforeTurnAdoptionRetry,
} from "./lifecycle.js";

afterEach(() => vi.useRealTimers());

describe("followup lifecycle heartbeat", () => {
  it("preserves a steer error while joining the already-started admission before settlement", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("steer notification failed");
    const lifecycle = {
      onAdopted: async () => {
        entered.resolve();
        await release.promise;
      },
      onAbandoned: vi.fn(),
      onSettled: vi.fn(),
    };
    const run = {
      turnAdoptionLifecycle: lifecycle,
      steerPending: {
        phase: "waiting" as const,
        predecessor: Promise.resolve(true),
        settle: () => {
          throw failure;
        },
      },
    };
    const admission = admitFollowupRunLifecycle(run);
    try {
      await entered.promise;
      expect(() => completeFollowupRunLifecycle(run)).toThrow(failure);
      expect(lifecycle.onSettled).not.toHaveBeenCalled();
      release.resolve();
      await admission;
      expect(lifecycle.onSettled).toHaveBeenCalledOnce();
      expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await admission;
    }
  });

  it.each(["admitted", "completed", "aborted"] as const)(
    "does not start renewal for an already %s lifecycle",
    async (state) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const lifecycle = {
        admission: "exclusive" as const,
        abortSignal: abort.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onDeferredHeartbeat: vi.fn(),
        deferredHeartbeatIntervalMs: 100,
        onAbandoned: vi.fn(),
      };
      const run = { turnAdoptionLifecycle: lifecycle };
      if (state === "admitted") {
        await admitFollowupRunLifecycle(run);
      } else if (state === "completed") {
        completeFollowupRunLifecycle(run);
      } else {
        abort.abort();
      }
      try {
        markFollowupRunEnqueued(run);
        await vi.advanceTimersByTimeAsync(500);
        expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        completeFollowupRunLifecycle(run);
      }
    },
  );
});

describe("followup lifecycle terminal disposition", () => {
  const createLifecycle = (abortSignal?: AbortSignal) => ({
    admission: "exclusive" as const,
    abortSignal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onCancelled: vi.fn(async () => {}),
    onAbandoned: vi.fn(),
    onSettled: vi.fn(),
  });

  it("settles an unadmitted run through onCancelled when it is cancelled", () => {
    const lifecycle = createLifecycle();
    completeFollowupRunLifecycle({ turnAdoptionLifecycle: lifecycle }, "cancelled");
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onSettled).toHaveBeenCalledOnce();
  });

  it("treats an already-aborted lifecycle as cancelled", () => {
    const abort = new AbortController();
    abort.abort();
    const lifecycle = createLifecycle(abort.signal);
    completeFollowupRunLifecycle({ turnAdoptionLifecycle: lifecycle });
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("abandons an unadmitted run that merely finished without the lane", () => {
    const lifecycle = createLifecycle(new AbortController().signal);
    completeFollowupRunLifecycle({ turnAdoptionLifecycle: lifecycle });
    expect(lifecycle.onAbandoned).toHaveBeenCalledOnce();
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
  });

  it("falls back to onAbandoned for a cancelled lifecycle that predates onCancelled", () => {
    const { onCancelled: _onCancelled, ...legacy } = createLifecycle();
    completeFollowupRunLifecycle({ turnAdoptionLifecycle: legacy }, "cancelled");
    expect(legacy.onAbandoned).toHaveBeenCalledOnce();
  });

  it("never fires a terminal callback for an admitted or consumed run", async () => {
    const admitted = createLifecycle();
    const run = { turnAdoptionLifecycle: admitted };
    await admitFollowupRunLifecycle(run);
    completeFollowupRunLifecycle(run, "cancelled");
    expect(admitted.onCancelled).not.toHaveBeenCalled();
    expect(admitted.onAbandoned).not.toHaveBeenCalled();

    const consumed = createLifecycle();
    completeFollowupRunLifecycle({ turnAdoptionLifecycle: consumed }, "consumed");
    expect(consumed.onCancelled).not.toHaveBeenCalled();
    expect(consumed.onAbandoned).not.toHaveBeenCalled();
  });

  it("runs a pre-retry release ahead of both terminal callbacks", async () => {
    const calls: string[] = [];
    const lifecycle = {
      onAdopted: vi.fn(),
      onCancelled: async () => {
        calls.push("cancelled");
      },
      onAbandoned: () => {
        calls.push("abandoned");
      },
    };
    releaseBeforeTurnAdoptionRetry(lifecycle, () => calls.push("release"));
    await lifecycle.onCancelled();
    lifecycle.onAbandoned();
    expect(calls).toEqual(["release", "cancelled", "release", "abandoned"]);

    const { onCancelled: _onCancelled, ...legacy } = { ...lifecycle };
    calls.length = 0;
    releaseBeforeTurnAdoptionRetry(legacy, () => calls.push("release"));
    expect("onCancelled" in legacy).toBe(false);
    legacy.onAbandoned?.();
    expect(calls).toEqual(["release", "release", "abandoned"]);
  });
});
