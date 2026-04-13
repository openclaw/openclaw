import { describe, expect, it } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { add, list } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-custom-id",
});

describe("cron service custom job ID", () => {
  it("should create job with custom ID", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-13T00:00:00.000Z");

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ ok: true, ran: true }),
    });

    const customId = "daily-brief";
    const job = await add(state, {
      id: customId,
      name: "Daily Brief",
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Generate daily brief" },
    });

    expect(job.id).toBe(customId);
    expect(job.name).toBe("Daily Brief");
  });

  it("should generate UUID when custom ID is not provided", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-13T00:00:00.000Z");

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ ok: true, ran: true }),
    });

    const job = await add(state, {
      name: "Daily Brief",
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Generate daily brief" },
    });

    expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(job.name).toBe("Daily Brief");
  });

  it("should reject duplicate custom IDs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-13T00:00:00.000Z");

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ ok: true, ran: true }),
    });

    const customId = "daily-brief";

    // Create first job with custom ID
    await add(state, {
      id: customId,
      name: "Daily Brief",
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Generate daily brief" },
    });

    // Try to create second job with same ID - should fail
    await expect(
      add(state, {
        id: customId,
        name: "Another Daily Brief",
        schedule: { kind: "every", everyMs: 86_400_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Generate another brief" },
      }),
    ).rejects.toThrow(`Job with id "${customId}" already exists`);
  });

  it("should allow multiple jobs with different custom IDs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-13T00:00:00.000Z");

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ ok: true, ran: true }),
    });

    const job1 = await add(state, {
      id: "daily-brief",
      name: "Daily Brief",
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Generate daily brief" },
    });

    const job2 = await add(state, {
      id: "weekly-report",
      name: "Weekly Report",
      schedule: { kind: "every", everyMs: 604_800_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Generate weekly report" },
    });

    expect(job1.id).toBe("daily-brief");
    expect(job2.id).toBe("weekly-report");

    const jobs = await list(state, { includeDisabled: true });
    expect(jobs).toHaveLength(2);
    expect(jobs[0].id).toBe("daily-brief");
    expect(jobs[1].id).toBe("weekly-report");
  });

  it("should support slug-like custom IDs with hyphens and underscores", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-13T00:00:00.000Z");

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ ok: true, ran: true }),
    });

    const validIds = [
      "daily-brief",
      "weekly_report",
      "monthly-summary-2024",
      "hourly_check",
    ];

    for (const id of validIds) {
      const job = await add(state, {
        id,
        name: `Job ${id}`,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Test" },
      });

      expect(job.id).toBe(id);
    }

    const jobs = await list(state, { includeDisabled: true });
    expect(jobs).toHaveLength(validIds.length);
  });
});
