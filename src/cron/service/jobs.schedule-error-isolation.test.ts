import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.test-support.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

function createMockState(jobs: CronJob[]): CronServiceState {
  const state = createCronRegressionState({
    storePath: "/tmp/cron-schedule-error-isolation.json",
    runIsolatedAgentJob: vi.fn(),
  });
  state.store = { version: 1, jobs };
  return state;
}

function createJob(expr = "0 * * * *", overrides: Partial<CronJob> = {}): CronJob {
  return makeCronJob({
    id: "bad-job",
    schedule: { kind: "cron", expr },
    sessionTarget: "main",
    ...overrides,
  });
}

function recompute(state: CronServiceState, deferredNotifications: DeferredCronNotifications = []) {
  return recomputeNextRunsForMaintenance(state, { recomputeExpired: true, deferredNotifications });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-15T10:30:00.000Z"));
});

afterEach(() => vi.useRealTimers());

it("recovers valid jobs around a malformed schedule", () => {
  const goodJob1 = createJob(undefined, { id: "good-1", state: { scheduleErrorCount: 2 } });
  const badJob = createJob("invalid cron expression");
  const goodJob2 = createJob(undefined, { id: "good-2" });
  const disabledJob = createJob("invalid", { id: "disabled", enabled: false });
  const state = createMockState([goodJob1, badJob, goodJob2, disabledJob]);

  expect(recompute(state)).toBe(true);
  expect(goodJob1.state.nextRunAtMs).toBeGreaterThan(Date.now());
  expect(goodJob1.state.scheduleErrorCount).toBeUndefined();
  expect(goodJob2.state.nextRunAtMs).toBeGreaterThan(Date.now());
  expect(disabledJob.state.scheduleErrorCount).toBeUndefined();
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
  expect(state.deps.enqueueSessionEvent).toHaveBeenCalledWith(
    expect.stringContaining("openclaw automations enable bad-job"),
    expect.objectContaining({ contextKey: "cron:bad-job:auto-disabled" }),
  );
  const notification = vi.mocked(state.deps.enqueueSessionEvent!).mock.calls[0]?.[0];
  expect(notification).toContain("Check automation history for details.");
  expect(notification).not.toContain("invalid configuration format");
});
