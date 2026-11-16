import { describe, expect, it, vi } from "vitest";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import { createGatewayUpdateCheck } from "../infra/update-startup-scheduler.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { refreshRemoteModelCatalog } from "./remote-refresh.js";

// mock-isolation: exercise catalog scheduling without starting package-update discovery.
vi.mock("../infra/update-startup.js", () => ({
  runGatewayUpdateCheck: vi.fn(async () => undefined),
  resolveCheckIntervalMs: () => 60 * 60_000,
}));
vi.mock("./remote-refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-refresh.js")>()),
  refreshRemoteModelCatalog: vi.fn(),
}));

describe("remote model catalog refresh reliability", () => {
  it("stops a failing catalog refresh after a bounded number of retries", async () => {
    vi.mocked(refreshRemoteModelCatalog).mockResolvedValue({
      status: "fresh",
      providers: 1,
      models: 1,
      generatedAt: 1_753_500_000_000,
      nextCheckInMs: 0,
    });
    const clock = createGatewaySchedulerClock(Date.parse("2026-01-17T10:00:00Z"));
    const check = createGatewayUpdateCheck({
      lifecycle: createGatewayUpdateLifecycle(createTestGatewayScheduler(clock.clock)),
      getConfig: () => ({}),
      applyRemoteCatalogUpdate: async () => {
        throw new Error("catalog adoption failed");
      },
      log: { info: vi.fn() },
      isNixMode: false,
    });
    vi.mocked(refreshRemoteModelCatalog).mockClear();
    check.start();
    try {
      await clock.advanceBy(0);
      expect(refreshRemoteModelCatalog).toHaveBeenCalledTimes(1);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await clock.advanceBy(1_000);
      }
      expect(vi.mocked(refreshRemoteModelCatalog).mock.calls.length).toBeGreaterThan(1);
      expect(vi.mocked(refreshRemoteModelCatalog).mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      await check.stop();
    }
  });
});
