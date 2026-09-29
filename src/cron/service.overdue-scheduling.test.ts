import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.js";
import { reserveQueuedCronRun } from "./service/run-admission.js";
import type { CronRunReceiptHandle } from "./store/run-receipt.types.js";
import type { CronJob } from "./types.js";

function createCronSystemEventJob(now: number, overrides: Partial<CronJob> = {}): CronJob {
  const { state, ...jobOverrides } = overrides;
  return {
    id: "test-job",
    name: "test job",
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    payload: { kind: "systemEvent", text: "test" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    createdAtMs: now,
    updatedAtMs: now,
    ...jobOverrides,
    state: state ? { ...state } : {},
  };
}

function testReceipt(jobId: string, startedAtMs: number): CronRunReceiptHandle {
  return {
    receiptId: `test:${jobId}`,
    storeKey: "test",
    jobId,
    configRevision: "test",
    agentId: "main",
    ownerPid: process.pid,
    ownerStartTime: 1,
    startedAtMs,
  };
}

describe("cron maintenance ownership", () => {
  it("clears an orphaned queued marker from before a clock rollback", () => {
    const now = Date.now();
    const futureQueuedAt = now + 3 * 60 * 60_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: now + 60_000,
        queuedAtMs: futureQueuedAt,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    expect(job.state.queuedAtMs).toBeUndefined();
  });

  it("clears an orphaned running marker from before a clock rollback", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const futureRunningAt = now + 3 * 60 * 60_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: futureRunningAt,
        lastRunAtMs: pastDue - 60_000,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [], recomputeExpired: true });

    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it.each(["queuedAtMs", "runningAtMs"] as const)(
    "preserves a future %s marker owned by a live reservation",
    (markerField) => {
      const now = Date.now();
      const futureMarker = now + 3 * 60 * 60_000;
      const job = createCronSystemEventJob(now, {
        state: {
          nextRunAtMs: now + 60_000,
          [markerField]: futureMarker,
        },
      });
      const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
      reserveQueuedCronRun(state, job.id, futureMarker, {
        runReceipt: testReceipt(job.id, futureMarker),
      });

      recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

      expect(job.state[markerField]).toBe(futureMarker);
    },
  );

  it("isolates schedule errors while filling missing nextRunAtMs", () => {
    const now = Date.now();
    const pastDue = now - 1_000;

    const dueJob = createCronSystemEventJob(now, {
      id: "due-job",
      state: {
        nextRunAtMs: pastDue,
      },
    });

    const malformedJob = createCronSystemEventJob(now, {
      id: "bad-job",
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      state: {},
    });

    const state = createMockCronStateForJobs({ jobs: [dueJob, malformedJob], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(true);
    expect(dueJob.state.nextRunAtMs).toBe(pastDue);
    expect(malformedJob.state.nextRunAtMs).toBeUndefined();
    expect(malformedJob.state.scheduleErrorCount).toBe(1);
    expect(malformedJob.state.lastError).toMatch(/^schedule error:/);
  });

  it("advances overdue already-executed jobs when stale running marker is cleared", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const staleRunningAt = now - 3 * 60 * 60_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: staleRunningAt,
        lastRunAtMs: pastDue + 1000,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, {
      deferredNotifications: [],
      recomputeExpired: true,
      nowMs: now,
    });

    expect(job.state.runningAtMs).toBeUndefined();
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);
  });
});
