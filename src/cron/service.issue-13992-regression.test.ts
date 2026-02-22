import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";
import type { CronJob } from "./types.js";

describe("issue #13992 regression - cron jobs skip execution", () => {
  it("should NOT recompute nextRunAtMs for past-due jobs during maintenance", () => {
    const now = Date.now();
    const pastDue = now - 60_000; // 1 minute ago

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue, // This is in the past and should NOT be recomputed
      },
    };

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should not have changed the past-due nextRunAtMs
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should compute missing nextRunAtMs during maintenance", () => {
    const now = Date.now();

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now,
      updatedAtMs: now,
      state: {
        // nextRunAtMs is missing
      },
    };

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have computed a nextRunAtMs
    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should clear nextRunAtMs for disabled jobs during maintenance", () => {
    const now = Date.now();
    const futureTime = now + 3600_000;

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: false, // Disabled
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now,
      updatedAtMs: now,
      state: {
        nextRunAtMs: futureTime,
      },
    };

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have cleared nextRunAtMs for disabled job
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it("should clear stuck running markers during maintenance", () => {
    const now = Date.now();
    const stuckTime = now - 3 * 60 * 60_000; // 3 hours ago (> 2 hour threshold)
    const futureTime = now + 3600_000;

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now,
      updatedAtMs: now,
      state: {
        nextRunAtMs: futureTime,
        runningAtMs: stuckTime, // Stuck running marker
      },
    };

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have cleared stuck running marker
    expect(job.state.runningAtMs).toBeUndefined();
    // But should NOT have changed nextRunAtMs (it's still future)
    expect(job.state.nextRunAtMs).toBe(futureTime);
  });

  it("isolates schedule errors while filling missing nextRunAtMs", () => {
    const now = Date.now();
    const pastDue = now - 1_000;

    const dueJob: CronJob = {
      id: "due-job",
      name: "due job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "due" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue,
      },
    };

    const malformedJob: CronJob = {
      id: "bad-job",
      name: "bad job",
      enabled: true,
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      payload: { kind: "systemEvent", text: "bad" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        // missing nextRunAtMs
      },
    };

    const state = createMockCronStateForJobs({ jobs: [dueJob, malformedJob], nowMs: now });

    expect(() => recomputeNextRunsForMaintenance(state)).not.toThrow();
    expect(dueJob.state.nextRunAtMs).toBe(pastDue);
    expect(malformedJob.state.nextRunAtMs).toBeUndefined();
    expect(malformedJob.state.scheduleErrorCount).toBe(1);
    expect(malformedJob.state.lastError).toMatch(/^schedule error:/);
  });
});
