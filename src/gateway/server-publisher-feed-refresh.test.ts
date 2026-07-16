import { describe, expect, it, vi } from "vitest";
import { startGatewayPublisherFeedRefresh } from "./server-publisher-feed-refresh.js";

describe("gateway publisher feed refresh", () => {
  it("refreshes serially, records bounded status, and stops future cycles", async () => {
    vi.useFakeTimers();
    try {
      const log = { error: vi.fn() };
      const run = vi
        .fn()
        .mockResolvedValueOnce([{ ok: true }, { ok: false, error: "offline" }])
        .mockResolvedValueOnce([{ ok: true }]);
      let tick = 0;
      const service = startGatewayPublisherFeedRefresh({
        log,
        intervalMs: 60_000,
        initialDelayMs: 1_000,
        dependencies: {
          run,
          now: () => new Date(`2026-07-16T00:00:0${tick++}.000Z`),
        },
      });

      expect(service.status()).toMatchObject({ running: false, stopped: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(service.status()).toMatchObject({
        running: false,
        lastFollowCount: 2,
        lastRefreshedCount: 1,
        lastFailedCount: 1,
      });
      expect(log.error).toHaveBeenCalledWith("publisher feed refresh failed: offline");

      const first = service.runNow();
      const overlapping = service.runNow();
      expect(overlapping).toBe(first);
      await first;
      expect(run).toHaveBeenCalledTimes(2);

      service.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(2);
      expect(service.status()).toMatchObject({ stopped: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the scheduler alive after a cycle-level failure", async () => {
    vi.useFakeTimers();
    try {
      const log = { error: vi.fn() };
      const run = vi.fn().mockRejectedValueOnce(new Error("database unavailable"));
      const service = startGatewayPublisherFeedRefresh({
        log,
        intervalMs: 60_000,
        initialDelayMs: 0,
        dependencies: { run },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.status()).toMatchObject({ lastFailedCount: 1, stopped: false });
      expect(log.error).toHaveBeenCalledWith(
        "publisher feed refresh cycle failed: Error: database unavailable",
      );
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
