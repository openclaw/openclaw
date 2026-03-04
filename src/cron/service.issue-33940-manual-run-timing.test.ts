import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { applyJobResult } from "./service/timer.js";
import type { CronJob } from "./types.js";

/**
 * Regression test for issue #33940: manual cron runs should not change timing.
 *
 * Root cause: applyJobResult used result.endedAt (actual execution time) to
 * compute the next run time. For a daily job at 7am run manually at 1pm,
 * the next run would be computed from 1pm -> tomorrow at 1pm instead of 7am.
 *
 * Fix: use job.state.nextRunAtMs (the scheduled time) as the base for
 * computing the next run, not result.endedAt (actual execution time).
 */
describe("issue #33940 - manual cron runs should not change timing", () => {
  const HOUR_MS = 3_600_000;
  const DAY_MS = 24 * HOUR_MS;

  function createDailySevenAmJob(sevenAmToday: number): CronJob {
    return {
      id: "daily-job-7am",
      name: "daily 7am",
      enabled: true,
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "morning affirmation" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: sevenAmToday - DAY_MS,
      updatedAtMs: sevenAmToday - DAY_MS,
      state: {
        nextRunAtMs: sevenAmToday,
      },
    };
  }

  it("manual run at 1pm should NOT shift next run to 1pm tomorrow", () => {
    // Scenario: daily job at 7am, user runs manually at 1pm (13:00)
    const sevenAmToday = Date.parse("2026-03-04T07:00:00.000Z"); // 7am
    const manualRunTime = sevenAmToday + 6 * HOUR_MS; // 1pm same day

    const job = createDailySevenAmJob(sevenAmToday);

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: manualRunTime });

    // Simulate a successful manual run at 1pm
    applyJobResult(state, job, {
      status: "ok",
      startedAt: manualRunTime - 1000, // started at 12:59pm
      endedAt: manualRunTime, // ended at 1pm
      delivered: true,
    });

    // The next run should still be tomorrow at 7am, NOT tomorrow at 1pm
    const expectedNextRun = sevenAmToday + DAY_MS; // tomorrow 7am
    const buggyNextRun = manualRunTime + DAY_MS; // tomorrow 1pm (the bug)

    expect(job.state.nextRunAtMs).not.toBe(buggyNextRun);
    expect(job.state.nextRunAtMs).toBe(expectedNextRun);
  });

  it("scheduled run (run at scheduled time) should compute next run correctly", () => {
    // Scenario: daily job at 7am, runs on schedule at 7am
    const sevenAmToday = Date.parse("2026-03-04T07:00:00.000Z"); // 7am
    const scheduledRunTime = sevenAmToday; // runs exactly at 7am

    const job = createDailySevenAmJob(sevenAmToday);

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: scheduledRunTime });

    // Simulate a successful scheduled run
    applyJobResult(state, job, {
      status: "ok",
      startedAt: scheduledRunTime,
      endedAt: scheduledRunTime + 1000,
      delivered: true,
    });

    // The next run should be tomorrow at 7am
    const expectedNextRun = sevenAmToday + DAY_MS;
    expect(job.state.nextRunAtMs).toBe(expectedNextRun);
  });

  it("manual run before scheduled time computes next run from scheduled time", () => {
    // Scenario: daily job at 7am, user runs manually at 6am (before schedule)
    // This is a less common case - when running before the scheduled time,
    // the next run is computed from the scheduled time forward.
    const sevenAmToday = Date.parse("2026-03-04T07:00:00.000Z"); // 7am
    const manualRunTime = sevenAmToday - HOUR_MS; // 6am same day

    const job = createDailySevenAmJob(sevenAmToday);

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: manualRunTime });

    // Simulate a successful manual run at 6am (before the scheduled 7am)
    applyJobResult(state, job, {
      status: "ok",
      startedAt: manualRunTime - 1000,
      endedAt: manualRunTime,
      delivered: true,
    });

    // When running before scheduled time, next run is computed from the
    // scheduled time forward (7am today -> tomorrow 7am)
    const expectedNextRun = sevenAmToday + DAY_MS; // tomorrow 7am
    expect(job.state.nextRunAtMs).toBe(expectedNextRun);
  });
});
