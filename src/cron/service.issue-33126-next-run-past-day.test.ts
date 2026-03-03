import { describe, expect, it } from "vitest";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import type { CronJob } from "./types.js";

/**
 * Issue #33126: Cron nextRunAtMs calculation error - sets past time instead of next day
 *
 * When a daily cron job (e.g., "0 3 * * *") runs past its scheduled time,
 * nextRunAtMs should be set to the next day's scheduled time, not the same
 * day's time (which is already in the past).
 */
describe("Cron issue #33126 nextRunAtMs past-day calculation", () => {
  // Use UTC timezone to avoid timezone/stagger complications
  function createDailyCronJob(overrides: Partial<CronJob> = {}): CronJob {
    return {
      id: "git-sync",
      name: "git-sync",
      enabled: true,
      createdAtMs: Date.now() - 86400_000, // created yesterday
      updatedAtMs: Date.now() - 86400_000,
      schedule: {
        kind: "cron",
        expr: "0 3 * * *",
        tz: "UTC", // Use UTC to simplify calculations
        staggerMs: 0, // Disable stagger for this test
      },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "sync" },
      delivery: { mode: "none" },
      state: {},
      ...overrides,
    };
  }

  it("returns next day's scheduled time when job runs past today's time", () => {
    // Scheduled: 03:00 UTC daily
    // Job actually completed at: 06:01:44 UTC (past today's scheduled time)
    // Expected next run: tomorrow's 03:00 UTC

    const lastRunMs = Date.parse("2026-03-03T06:01:44Z"); // 1772546504233
    const expectedNextMs = Date.parse("2026-03-04T03:00:00Z"); // 1772650800000

    const job = createDailyCronJob({
      state: {
        lastRunAtMs: lastRunMs,
        lastStatus: "ok",
      },
    });

    // Now is right after the job completed
    const nowMs = lastRunMs + 1;

    const nextRun = computeJobNextRunAtMs(job, nowMs);

    // nextRun should be tomorrow's scheduled time, not today's (which is already passed)
    expect(nextRun).toBeDefined();
    expect(nextRun).toBe(expectedNextMs);
  });

  it("returns today's scheduled time when job runs before scheduled time", () => {
    // Scheduled: 03:00 UTC
    // Job runs at: 02:00 UTC (before scheduled)
    // Expected next run: today's 03:00 UTC

    const scheduledMs = Date.parse("2026-03-03T03:00:00Z");
    const lastRunMs = Date.parse("2026-03-03T02:00:00Z");

    const job = createDailyCronJob({
      state: {
        lastRunAtMs: lastRunMs,
        lastStatus: "ok",
      },
    });

    // Now is right after the job completed
    const nowMs = lastRunMs + 1;

    const nextRun = computeJobNextRunAtMs(job, nowMs);

    // nextRun should be today's scheduled time
    expect(nextRun).toBeDefined();
    expect(nextRun).toBe(scheduledMs);
  });

  it("returns next day when job runs exactly at scheduled time", () => {
    // Scheduled: 03:00 UTC
    // Job runs exactly at: 03:00:00 UTC
    // Expected next run: tomorrow's 03:00 UTC

    const lastRunMs = Date.parse("2026-03-03T03:00:00Z");
    const expectedNextMs = Date.parse("2026-03-04T03:00:00Z");

    const job = createDailyCronJob({
      state: {
        lastRunAtMs: lastRunMs,
        lastStatus: "ok",
      },
    });

    const nowMs = lastRunMs + 1;

    const nextRun = computeJobNextRunAtMs(job, nowMs);

    expect(nextRun).toBeDefined();
    expect(nextRun).toBe(expectedNextMs);
  });
});
