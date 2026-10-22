import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.test-support.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

function createMockState(jobs: CronJob[]): CronServiceState {
  const state = createCronRegressionState({
    storePath: "/tmp/cron-schedule-error-isolation.json",
    log: createNoopLogger(),
    runIsolatedAgentJob: vi.fn(),
    onEvent: vi.fn(),
  });
  state.store = { version: 1, jobs };
  return state;
}

function createJob(expr = "0 * * * *", overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "bad-job",
    name: "Bad Job",
    enabled: true,
    createdAtMs: Date.now() - 100_000,
    updatedAtMs: Date.now() - 100_000,
    schedule: { kind: "cron", expr },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
    ...overrides,
  };
}

function recompute(state: CronServiceState, deferredNotifications: DeferredCronNotifications = []) {
  return recomputeNextRunsForMaintenance(state, { recomputeExpired: true, deferredNotifications });
}

describe("cron schedule error isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers valid jobs around a malformed schedule", () => {
    const goodJob1 = createJob(undefined, { id: "good-1", state: { scheduleErrorCount: 2 } });
    const badJob = createJob("invalid cron expression");
    const goodJob2 = createJob(undefined, { id: "good-2" });

    const state = createMockState([goodJob1, badJob, goodJob2]);

    expect(recompute(state)).toBe(true);
    expect(goodJob1.state.nextRunAtMs).toBeGreaterThan(Date.now());
    expect(goodJob1.state.scheduleErrorCount).toBeUndefined();
    expect(goodJob2.state.nextRunAtMs).toBeGreaterThan(Date.now());
    expect(badJob).toMatchObject({
      enabled: true,
      state: {
        nextRunAtMs: undefined,
        lastError: expect.stringMatching(/schedule error/),
        scheduleErrorCount: 1,
      },
    });
  });

  it("auto-disables job after 3 consecutive schedule errors", async () => {
    const badJob = createJob("garbage", { state: { scheduleErrorCount: 2 } });
    const state = createMockState([badJob]);

    const deferredNotifications: DeferredCronNotifications = [];
    recompute(state, deferredNotifications);
    expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
    await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));

    expect(badJob).toMatchObject({
      enabled: false,
      state: { scheduleErrorCount: 3 },
    });
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
    expect(state.deps.enqueueSessionEvent).toHaveBeenCalledWith(
      expect.stringContaining("openclaw automations enable bad-job"),
      expect.objectContaining({ contextKey: "cron:bad-job:auto-disabled" }),
    );
    const notification = vi.mocked(state.deps.enqueueSessionEvent!).mock.calls[0]?.[0];
    expect(notification).toContain("Check automation history for details.");
    expect(notification).not.toContain("invalid configuration format");
  });

  it("does not modify disabled jobs", () => {
    const disabledBadJob = createJob("invalid", { enabled: false });
    const state = createMockState([disabledBadJob]);

    recompute(state);
    expect(disabledBadJob.state.scheduleErrorCount).toBeUndefined();
    expect(state.deps.log.warn).not.toHaveBeenCalled();
  });

  it("records a clear schedule error when cron expr is missing", () => {
    const badJob = createJob(undefined, {
      schedule: { kind: "cron" } as unknown as CronJob["schedule"],
    });
    const state = createMockState([badJob]);

    recompute(state);

    expect(badJob.state.lastError).toContain("invalid cron schedule: expr is required");
    expect(badJob.state.lastError).not.toContain("Cannot read properties of undefined");
    expect(badJob.state.scheduleErrorCount).toBe(1);
  });
});
