import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  markFollowupRunEnqueued,
} from "./lifecycle.js";

afterEach(() => vi.useRealTimers());

describe("followup lifecycle heartbeat", () => {
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
