// Cron service regression tests cover historical scheduling edge cases.
import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import {
  needsCronTimerMaintenance,
  recomputeNextRunsForMaintenance,
} from "./service/jobs-scheduling.js";
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

// regression: #13992
describe("issue #13992 regression - cron jobs skip execution", () => {
  it.each([
    {
      name: "already-executed slot",
      state: (now: number, next: number) => ({ nextRunAtMs: next, lastRunAtMs: next + 1 }),
      expected: true,
    },
    {
      name: "active queued slot",
      state: (now: number, next: number) => ({ nextRunAtMs: next, queuedAtMs: now }),
      expected: false,
    },
    {
      name: "startup catch-up slot",
      state: (_now: number, next: number) => ({
        nextRunAtMs: next,
        lastRunAtMs: next + 1,
        startupCatchupAtMs: next,
      }),
      expected: false,
    },
    {
      name: "force-preserved slot",
      state: (_now: number, next: number) => ({
        nextRunAtMs: next,
        lastRunAtMs: next + 1,
        forcePreservedNextRunAtMs: next,
      }),
      expected: false,
    },
  ])("classifies $name for expired maintenance", ({ state, expected }) => {
    const now = Date.now();
    const next = now - 60_000;
    const job = createCronSystemEventJob(now, { state: state(now, next) });

    expect(needsCronTimerMaintenance(job, now)).toBe(expected);
  });

  it("should NOT recompute nextRunAtMs for past-due jobs by default", () => {
    const now = Date.now();
    const pastDue = now - 60_000; // 1 minute ago

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue, // This is in the past and should NOT be recomputed
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    // Should not have changed the past-due nextRunAtMs
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should NOT recompute past-due nextRunAtMs for running jobs even with recomputeExpired", () => {
    const now = Date.now();
    const pastDue = now - 60_000;

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: now - 500,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [], recomputeExpired: true });

    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should compute missing nextRunAtMs during maintenance", () => {
    const now = Date.now();

    const job = createCronSystemEventJob(now, {
      state: {
        // nextRunAtMs is missing
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    // Should have computed a nextRunAtMs
    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should repair nextRunAtMs=0 during maintenance", () => {
    const now = Date.now();

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: 0,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should clear nextRunAtMs for disabled jobs during maintenance", () => {
    const now = Date.now();
    const futureTime = now + 3600_000;

    const job = createCronSystemEventJob(now, {
      enabled: false, // Disabled
      state: {
        nextRunAtMs: futureTime,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    // Should have cleared nextRunAtMs for disabled job
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it("should clear stuck running markers during maintenance", () => {
    const now = Date.now();
    const stuckTime = now - 3 * 60 * 60_000; // 3 hours ago (> 2 hour threshold)
    const futureTime = now + 3600_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: futureTime,
        runningAtMs: stuckTime, // Stuck running marker
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

    // Should have cleared stuck running marker
    expect(job.state.runningAtMs).toBeUndefined();
    // But should NOT have changed nextRunAtMs (it's still future)
    expect(job.state.nextRunAtMs).toBe(futureTime);
  });

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

  it.each(["queuedAtMs", "runningAtMs"] as const)(
    "preserves a near-future %s marker within the stale-run window",
    (markerField) => {
      const now = Date.now();
      const futureMarker = now + 1_000;
      const job = createCronSystemEventJob(now, {
        state: {
          nextRunAtMs: now + 60_000,
          [markerField]: futureMarker,
        },
      });
      const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

      recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });

      expect(job.state[markerField]).toBe(futureMarker);
    },
  );

  it("isolates schedule errors while filling missing nextRunAtMs", () => {
    const now = Date.now();
    const pastDue = now - 1_000;

    const dueJob = createCronSystemEventJob(now, {
      id: "due-job",
      name: "due job",
      payload: { kind: "systemEvent", text: "due" },
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue,
      },
    });

    const malformedJob = createCronSystemEventJob(now, {
      id: "bad-job",
      name: "bad job",
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      payload: { kind: "systemEvent", text: "bad" },
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        // missing nextRunAtMs
      },
    });

    const state = createMockCronStateForJobs({ jobs: [dueJob, malformedJob], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(true);
    expect(dueJob.state.nextRunAtMs).toBe(pastDue);
    expect(malformedJob.state.nextRunAtMs).toBeUndefined();
    expect(malformedJob.state.scheduleErrorCount).toBe(1);
    expect(malformedJob.state.lastError).toMatch(/^schedule error:/);
  });

  it("recomputes expired slots already executed but keeps never-executed stale slots", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const alreadyExecuted = createCronSystemEventJob(now, {
      id: "already-executed",
      name: "already executed",
      payload: { kind: "systemEvent", text: "done" },
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      state: {
        nextRunAtMs: pastDue,
        lastRunAtMs: pastDue + 1000,
      },
    });

    const neverExecuted = createCronSystemEventJob(now, {
      id: "never-executed",
      name: "never executed",
      payload: { kind: "systemEvent", text: "pending" },
      createdAtMs: now - 86400_000 * 2,
      updatedAtMs: now - 86400_000 * 2,
      state: {
        nextRunAtMs: pastDue,
        lastRunAtMs: pastDue - 86400_000,
      },
    });

    const state = createMockCronStateForJobs({
      jobs: [alreadyExecuted, neverExecuted],
      nowMs: now,
    });
    recomputeNextRunsForMaintenance(state, { deferredNotifications: [], recomputeExpired: true });

    expect((alreadyExecuted.state.nextRunAtMs ?? 0) > now).toBe(true);
    expect(neverExecuted.state.nextRunAtMs).toBe(pastDue);
  });

  it("does not advance overdue never-executed jobs when stale running marker is cleared", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const staleRunningAt = now - 3 * 60 * 60_000;

    const job = createCronSystemEventJob(now, {
      id: "stale-running-overdue",
      name: "stale running overdue",
      payload: { kind: "systemEvent", text: "test" },
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: staleRunningAt,
        lastRunAtMs: pastDue - 3600_000,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, {
      deferredNotifications: [],
      recomputeExpired: true,
      nowMs: now,
    });

    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("advances overdue already-executed jobs when stale running marker is cleared", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const staleRunningAt = now - 3 * 60 * 60_000;

    const job = createCronSystemEventJob(now, {
      id: "stale-running-already-executed",
      name: "stale running already executed",
      payload: { kind: "systemEvent", text: "test" },
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
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
