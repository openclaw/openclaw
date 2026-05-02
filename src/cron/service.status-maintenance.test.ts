import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { status } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";

describe("cron.status maintenance diagnostics", () => {
  const { logger, makeStorePath } = setupCronServiceSuite({
    prefix: "cron-status-maintenance-",
  });

  it("returns maintenance phase diagnostics and deferred counters", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const now = Date.parse("2026-03-26T02:30:00.000Z");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "job-maint-status",
          name: "maintenance status",
          enabled: true,
          agentId: "main",
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "status" },
          state: {
            nextRunAtMs: now + 60_000,
            deferredMaintenanceRuns: 2,
            firstDeferredMaintenanceAtMs: now - 10_000,
            lastDeferredMaintenanceAtMs: now - 5_000,
          },
        },
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      cronConfig: {
        maintenance: {
          enabled: true,
          window: {
            start: "00:00",
            end: "23:59",
            timezone: "UTC",
          },
          maintenanceAgents: ["maint"],
        },
      },
      defaultAgentId: "main",
      userTimezone: "UTC",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
    });

    try {
      const res = await status(state);
      expect(res.maintenance).toMatchObject({
        enabled: true,
        phase: "maintenance",
        maintenanceAgents: ["maint"],
        deferredJobs: 1,
        deferredRuns: 2,
      });
      expect(res.maintenance?.window).toEqual({
        start: "00:00",
        end: "23:59",
        timezone: "UTC",
      });
    } finally {
      await cleanup();
    }
  });
});
