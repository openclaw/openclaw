// Schedule error isolation tests cover one bad job not blocking other cron jobs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { CronJob } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import {
  createCronServiceState,
  type CronServiceState,
  type DeferredCronNotifications,
} from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

function createMockState(jobs: CronJob[]): CronServiceState {
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "/tmp/cron-schedule-error-isolation.json",
    cronEnabled: true,
    nowMs: () => Date.now(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    onEvent: vi.fn(),
  });
  state.store = { version: 1, jobs };
  return state;
}

function createJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    enabled: true,
    createdAtMs: Date.now() - 100_000,
    updatedAtMs: Date.now() - 100_000,
    schedule: { kind: "cron", expr: "0 * * * *" }, // Every hour
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
    ...overrides,
  };
}

function requireTimestamp(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`expected ${label} timestamp`);
  }
  return value;
}

describe("cron schedule error isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues processing other jobs when one has a malformed schedule", () => {
    const goodJob1 = createJob({ id: "good-1", name: "Good Job 1" });
    const badJob = createJob({
      id: "bad-job",
      name: "Bad Job",
      schedule: { kind: "cron", expr: "invalid cron expression" },
    });
    const goodJob2 = createJob({ id: "good-2", name: "Good Job 2" });

    const state = createMockState([goodJob1, badJob, goodJob2]);

    const changed = recomputeNextRunsForMaintenance(state, {
      recomputeExpired: true,
      deferredNotifications: [],
    });

    expect(changed).toBe(true);
    // Good jobs should have their nextRunAtMs computed
    expect(requireTimestamp(goodJob1.state.nextRunAtMs, "good-1 next run")).toBeGreaterThan(
      Date.now(),
    );
    expect(requireTimestamp(goodJob2.state.nextRunAtMs, "good-2 next run")).toBeGreaterThan(
      Date.now(),
    );
    // Bad job should have undefined nextRunAtMs and an error recorded
    expect(badJob.state.nextRunAtMs).toBeUndefined();
    expect(badJob.state.lastError).toMatch(/schedule error/);
    expect(badJob.state.scheduleErrorCount).toBe(1);
    // Job should still be enabled after first error
    expect(badJob.enabled).toBe(true);
  });

  it("auto-disables job after 3 consecutive schedule errors", () => {
    const badJob = createJob({
      id: "bad-job",
      name: "Bad Job",
      schedule: { kind: "cron", expr: "garbage" },
      state: { scheduleErrorCount: 2 }, // Already had 2 errors
    });
    const state = createMockState([badJob]);

    const deferredNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true, deferredNotifications });
    expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    runPostPersistCronNotifications(state, structuredClone(deferredNotifications));

    // After 3rd error, job should be disabled
    expect(badJob.enabled).toBe(false);
    expect(badJob.state.scheduleErrorCount).toBe(3);
    expect(badJob.state.autoDisabled).toEqual({
      reason: "schedule-errors",
      atMs: Date.now(),
      consecutiveErrors: 3,
    });
    expect(state.deps.log.error).toHaveBeenCalledWith(
      {
        jobId: "bad-job",
        name: "Bad Job",
        errorCount: 3,
        err: "CronPattern: invalid configuration format ('garbage'), exactly five, six, or seven space separated parts are required.",
      },
      "cron: auto-disabled job after repeated schedule errors",
    );
    expect(state.deps.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("openclaw automations enable bad-job"),
      expect.objectContaining({ contextKey: "cron:bad-job:auto-disabled" }),
    );
    const notification = vi.mocked(state.deps.enqueueSystemEvent).mock.calls[0]?.[0];
    expect(notification).toContain("Check automation history for details.");
    expect(notification).not.toContain("invalid configuration format");
  });

  it("clears scheduleErrorCount when schedule computation succeeds", () => {
    const job = createJob({
      id: "recovering-job",
      name: "Recovering Job",
      schedule: { kind: "cron", expr: "0 * * * *" }, // Valid
      state: { scheduleErrorCount: 2 }, // Had previous errors
    });
    const state = createMockState([job]);

    const changed = recomputeNextRunsForMaintenance(state, {
      recomputeExpired: true,
      deferredNotifications: [],
    });

    expect(changed).toBe(true);
    expect(requireTimestamp(job.state.nextRunAtMs, "recovering next run")).toBeGreaterThan(
      Date.now(),
    );
    expect(job.state.scheduleErrorCount).toBeUndefined();
  });

  it("does not modify disabled jobs", () => {
    const disabledBadJob = createJob({
      id: "disabled-bad",
      name: "Disabled Bad Job",
      enabled: false,
      schedule: { kind: "cron", expr: "invalid" },
    });
    const state = createMockState([disabledBadJob]);

    recomputeNextRunsForMaintenance(state, { recomputeExpired: true, deferredNotifications: [] });

    // Should not attempt to compute schedule for disabled jobs
    expect(disabledBadJob.state.scheduleErrorCount).toBeUndefined();
    expect(state.deps.log.warn).not.toHaveBeenCalled();
  });

  it("records a clear schedule error when cron expr is missing", () => {
    const badJob = createJob({
      id: "missing-expr",
      name: "Missing Expr",
      schedule: { kind: "cron" } as unknown as CronJob["schedule"],
    });
    const state = createMockState([badJob]);

    recomputeNextRunsForMaintenance(state, { recomputeExpired: true, deferredNotifications: [] });

    expect(badJob.state.lastError).toContain("invalid cron schedule: expr is required");
    expect(badJob.state.lastError).not.toContain("Cannot read properties of undefined");
    expect(badJob.state.scheduleErrorCount).toBe(1);
  });
});
