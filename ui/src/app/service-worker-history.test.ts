// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createFetchServiceWorker,
  offlineBootFixture,
  stallDownloads,
} from "./service-worker-cache.test-support.ts";

describe("Control UI offline app shell", () => {
  it("bounds initial downloads before foreground loading can interrupt them", async () => {
    vi.useFakeTimers();
    try {
      const assets = Array.from({ length: 9 }, (_, index) => ({
        ...offlineBootFixture.assets[0],
        path: `assets/page-${index}-AbCd1234.js`,
      }));
      const worker = createFetchServiceWorker(undefined, { assets });
      const signals = stallDownloads(worker);
      const preparation = worker.install();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals).toHaveLength(4);
      worker.foregroundActivity(true);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      worker.fetch.mockImplementation(async () => new Response("build asset"));
      worker.foregroundActivity(false);
      await vi.runAllTimersAsync();
      await preparation;
      for (const asset of assets) {
        expect(worker.cache.has(worker.scope + asset.path)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["install", "deferred"])(
    "pauses %s downloads for foreground loading across windows and resumes after a waiting window closes",
    async (phase) => {
      vi.useFakeTimers();
      try {
        const worker = createFetchServiceWorker();
        if (phase === "deferred") {
          worker.cache.set(worker.scope + "__offline_shell__", new Response("shell"));
        }
        const signals = stallDownloads(worker);
        const preparation =
          phase === "install" ? worker.install() : worker.probe({ saveData: false });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(signals.length).toBeGreaterThan(0);
        worker.foregroundActivity(true);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        worker.foregroundActivity(true, 1);
        worker.foregroundActivity(false);
        worker.fetch.mockImplementation(async () => new Response("build asset"));
        const interruptedCount = worker.fetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(worker.fetch).toHaveBeenCalledTimes(interruptedCount);
        worker.matchClients.mockResolvedValue([worker.windowClients[0]]);
        await vi.runAllTimersAsync();
        await preparation;
        const assets =
          phase === "install" ? offlineBootFixture.assets : offlineBootFixture.deferredAssets;
        for (const asset of assets) {
          expect(worker.cache.has(worker.scope + asset.path)).toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
