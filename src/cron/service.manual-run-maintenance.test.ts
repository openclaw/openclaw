import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-manual-maintenance-",
});

describe("cron.run maintenance gating", () => {
  it("returns maintenance-blocked when phase/role forbids manual run", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const now = Date.parse("2026-03-26T02:30:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ok" }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          id: "manual-blocked",
          name: "manual blocked",
          enabled: true,
          agentId: "main",
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "blocked" },
          state: { nextRunAtMs: now - 1 },
        } satisfies CronJob,
      ],
    });

    const cron = new CronService({
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
      runIsolatedAgentJob,
    });

    try {
      const result = await cron.run("manual-blocked", "force");
      expect(result).toEqual({ ok: true, ran: false, reason: "maintenance-blocked" });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await cleanup();
    }
  });
});
