// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createFetchServiceWorker,
  offlineBootFixture,
  stallDownloads,
} from "./service-worker-cache.test-support.ts";

describe("Control UI offline app shell", () => {
  it.each(["install", "deferred"])(
    "pauses %s downloads for history across windows and resumes after a waiting window closes",
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
        worker.historyActivity(true);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        worker.historyActivity(true, 1);
        worker.historyActivity(false);
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
