import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronJob, CronPacing } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { createCronServiceState, type DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import type { CronJobRunResult } from "./timer-execution-timeout.js";
import {
  applyJobResult,
  applyOutcomeToAuthoritativeJob,
  applyTriggerNoFireResult,
} from "./timer-outcomes.js";
import { authorCronRunCompletion } from "./timer.js";

const ENDED_AT = Date.parse("2026-07-18T12:00:00.000Z");
const STARTED_AT = ENDED_AT - 1_000;

function makeState() {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "/tmp/cron-pacing-timer/jobs.json",
    cronEnabled: true,
    log: createNoopLogger(),
    nowMs: () => ENDED_AT,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function makePacedJob(pacing: CronPacing = { min: "15m", max: "4h" }, everyMs = 3_600_000) {
  return makeCronJob({
    pacing,
    schedule: { kind: "every", everyMs, anchorMs: STARTED_AT },
    state: { nextRunAtMs: STARTED_AT },
  });
}

function complete(job: CronJob, result: Partial<CronJobRunResult>, preserve = false) {
  applyJobResult(
    makeState(),
    job,
    { status: "ok", startedAt: STARTED_AT, endedAt: ENDED_AT, ...result },
    { deferredNotifications: [], scheduleMode: preserve ? "preserve" : "advance" },
  );
}

function maintain(job: CronJob) {
  const state = makeState();
  state.store = { version: 1, jobs: [job] };
  recomputeNextRunsForMaintenance(state, { deferredNotifications: [], nowMs: ENDED_AT + 1_000 });
}

describe("cron dynamic cadence", () => {
  it.each(["one-shot retry", "recurring retry", "pacing", "trigger floor", "quiet trigger"])(
    "auto-disables a job when %s cannot produce a Date-valid next run",
    (scenario) => {
      const endedAt = MAX_DATE_TIMESTAMP_MS - 1_000;
      const state = makeState();
      const deferredNotifications: DeferredCronNotifications = [];
      const job = makeCronJob({
        schedule:
          scenario === "one-shot retry"
            ? { kind: "at", at: new Date(endedAt).toISOString() }
            : { kind: "every", everyMs: 1_000, anchorMs: 0 },
        state: { nextRunAtMs: endedAt },
        ...(scenario === "pacing" ? { pacing: { min: "1s" } } : {}),
        ...(scenario === "trigger floor" || scenario === "quiet trigger"
          ? { trigger: { script: "return true" } }
          : {}),
      });
      const times = { startedAt: endedAt - 1, endedAt };
      if (scenario === "quiet trigger") {
        applyTriggerNoFireResult(
          state,
          job,
          { ...times, triggerEval: { fired: false, stateChanged: false } },
          { deferredNotifications },
        );
      } else {
        const retry = scenario === "one-shot retry" || scenario === "recurring retry";
        applyJobResult(
          state,
          job,
          {
            ...times,
            status: retry ? "error" : "ok",
            ...(retry
              ? {
                  error: "temporary timeout",
                  errorClassification: { kind: "reason" as const, reason: "timeout" as const },
                  executionStarted: true,
                }
              : {}),
            ...(scenario === "pacing" ? { nextCheck: { delayMs: 2_000 } } : {}),
          },
          { deferredNotifications },
        );
      }
      expect(job.enabled).toBe(false);
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.state.pacedNextRunAtMs).toBeUndefined();
      expect(job.state.autoDisabled).toEqual({
        reason: "schedule-errors",
        atMs: ENDED_AT,
        consecutiveErrors: 1,
      });
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
      expect(deferredNotifications).toHaveLength(1);
      runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
      expect(state.deps.enqueueSystemEvent).toHaveBeenCalledOnce();
      expect(state.deps.requestHeartbeat).toHaveBeenCalledOnce();
    },
  );

  it("disables an exhausted every schedule instead of synthesizing a backoff-only run", () => {
    const endedAt = MAX_DATE_TIMESTAMP_MS - 39_000;
    const job = makeCronJob({
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      state: { nextRunAtMs: endedAt },
    });
    complete(job, {
      status: "error",
      error: "permanent failure",
      errorClassification: { kind: "permanent" },
      startedAt: endedAt - 1_000,
      endedAt,
    });
    expect(endedAt + 30_000).toBeLessThanOrEqual(MAX_DATE_TIMESTAMP_MS);
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it.each([
    ["minimum-only", { min: "15m" }, 5 * 60_000, 15 * 60_000],
    ["maximum-only", { max: "4h" }, 6 * 3_600_000, 4 * 3_600_000],
  ] as const)("clamps a %s job", (_, pacing, delayMs, expectedDelayMs) => {
    const job = makePacedJob(pacing);
    complete(job, { nextCheck: { delayMs } });
    expect(job.state.nextRunAtMs).toBe(ENDED_AT + expectedDelayMs);
    expect(job.state.pacedNextRunAtMs).toBe(ENDED_AT + expectedDelayMs);
  });

  it("preserves an edited pacing override and force marker after a stale quiet trigger", () => {
    const state = makeState();
    const job = makePacedJob();
    const admittedJob = structuredClone(job);
    const nextRunAtMs = ENDED_AT + 45 * 60_000;
    const forcePreservedNextRunAtMs = ENDED_AT + 15 * 60_000;
    job.schedule = { kind: "every", everyMs: 2 * 3_600_000, anchorMs: STARTED_AT };
    job.state = { nextRunAtMs, pacedNextRunAtMs: nextRunAtMs, forcePreservedNextRunAtMs };
    state.store = { version: 1, jobs: [job] };
    applyOutcomeToAuthoritativeJob(
      state,
      job,
      authorCronRunCompletion(state, admittedJob, {
        jobId: job.id,
        job: admittedJob,
        status: "ok",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        triggerEval: { fired: false, stateChanged: false },
      }),
      { deferredNotifications: [] },
    );
    expect(job.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(job.state.pacedNextRunAtMs).toBe(nextRunAtMs);
    expect(job.state.forcePreservedNextRunAtMs).toBe(forcePreservedNextRunAtMs);
  });

  it("preserves the exact paced slot when a forced run records a new proposal", () => {
    const job = makePacedJob();
    const pendingSlot = ENDED_AT + 45 * 60_000;
    job.state = { nextRunAtMs: pendingSlot, pacedNextRunAtMs: pendingSlot };
    complete(job, { nextCheck: { delayMs: 2 * 3_600_000 } }, true);
    expect(job.state.nextRunAtMs).toBe(pendingSlot);
    expect(job.state.pacedNextRunAtMs).toBe(pendingSlot);
  });

  it("applies the built-in trigger floor after the job-local pacing clamp", () => {
    const job = makePacedJob({ min: "1s", max: "2m" });
    job.trigger = { script: "return true" };
    complete(job, { nextCheck: { delayMs: 1_000 } });
    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 30_000);
    expect(job.state.pacedNextRunAtMs).toBe(ENDED_AT + 30_000);
  });

  it("discards proposals on error so normal backoff wins", () => {
    const job = makePacedJob({ min: "1h", max: "2h" }, 10_000);
    job.state.pacedNextRunAtMs = ENDED_AT + 90 * 60_000;
    complete(job, {
      status: "error",
      error: "temporary failure",
      nextCheck: { delayMs: 90 * 60_000 },
    });
    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 30_000);
    expect(job.state.pacedNextRunAtMs).toBeUndefined();
  });

  it("preserves a paced cron-expression override during future-slot repair", () => {
    const job = makePacedJob();
    job.schedule = { kind: "cron", expr: "* * * * *", tz: "UTC" };
    complete(job, { nextCheck: { delayMs: 30 * 60_000 } });
    maintain(job);
    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 30 * 60_000);
    expect(job.state.pacedNextRunAtMs).toBe(ENDED_AT + 30 * 60_000);
  });

  it("repairs a future slot whose persisted pacing marker does not match", () => {
    const job = makePacedJob();
    job.schedule = { kind: "cron", expr: "* * * * *", tz: "UTC" };
    job.state = {
      nextRunAtMs: ENDED_AT + 30 * 60_000 + 1_234,
      pacedNextRunAtMs: ENDED_AT + 45 * 60_000,
    };
    maintain(job);
    expect(job.state.nextRunAtMs).toBe(ENDED_AT + 60_000);
    expect(job.state.pacedNextRunAtMs).toBeUndefined();
  });
});
