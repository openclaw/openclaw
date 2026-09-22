import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  markFollowupRunEnqueued,
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
