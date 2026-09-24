// Daily skip regression tests cover missed-run handling for daily cron jobs.
import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.js";
import type { CronJob } from "./types.js";

// Maintenance must preserve a daily slot that became due during another job execution.
// regression: #17852
describe("issue #17852 - daily cron jobs should not skip days", () => {
  const HOUR_MS = 3_600_000;
  const DAY_MS = 24 * HOUR_MS;

  function createDailyThreeAmJob(threeAM: number): CronJob {
    return {
      id: "daily-job",
      name: "daily 3am",
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "daily task" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: threeAM - DAY_MS,
      updatedAtMs: threeAM - DAY_MS,
      state: {
        nextRunAtMs: threeAM,
      },
    };
  }

  it("recomputeNextRunsForMaintenance should NOT advance past-due nextRunAtMs by default", () => {
    // Simulate: job scheduled for 3:00 AM, timer processing happens at 3:00:01
    // The job was NOT executed in this tick (e.g., it became due between
    // findDueJobs and the post-execution block).
    const threeAM = Date.parse("2026-02-16T03:00:00.000Z");
    const now = threeAM + 1_000; // 3:00:01

    const job = createDailyThreeAmJob(threeAM);

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    // Maintenance should NOT touch existing past-due nextRunAtMs.
    // The job should still be eligible for execution on the next timer tick.
    expect(job.state.nextRunAtMs).toBe(threeAM);
  });

  it("recomputeNextRunsForMaintenance can advance expired nextRunAtMs on recovery path when slot already executed", () => {
    const threeAM = Date.parse("2026-02-16T03:00:00.000Z");
    const now = threeAM + 1_000; // 3:00:01

    const job = createDailyThreeAmJob(threeAM);
    job.state.lastRunAtMs = threeAM + 1;

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [], recomputeExpired: true });

    const tomorrowThreeAM = threeAM + DAY_MS;
    expect(job.state.nextRunAtMs).toBe(tomorrowThreeAM);
  });
});
