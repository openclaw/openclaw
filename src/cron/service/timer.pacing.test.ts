import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob, CronPacing } from "../types.js";
import { recomputeNextRunsForMaintenance } from "./jobs-scheduling.test-support.js";
import type { DeferredCronNotifications } from "./state.js";
import type { CronJobRunResult } from "./timer-execution-timeout.js";
import { authorCronRunCompletion } from "./timer-job-runner.js";
import { applyJobResult, applyOutcomeToAuthoritativeJob } from "./timer-outcomes.js";

const ENDED_AT = Date.parse("2026-07-18T12:00:00.000Z");
const STARTED_AT = ENDED_AT - 1_000;

function makeState() {
  return createCronRegressionState({
    storePath: "/tmp/cron-pacing-timer/jobs.json",
    nowMs: () => ENDED_AT,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function makePacedJob(pacing: CronPacing = { min: "15m", max: "4h" }) {
  return makeCronJob({
    pacing,
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: STARTED_AT },
    state: { nextRunAtMs: STARTED_AT },
  });
}

function complete(job: CronJob, result: Partial<CronJobRunResult>) {
  const state = makeState();
  const deferredNotifications: DeferredCronNotifications = [];
  applyJobResult(
    state,
    job,
    { status: "ok", startedAt: STARTED_AT, endedAt: ENDED_AT, ...result },
    { deferredNotifications },
  );
  return { state, deferredNotifications };
}

function maintain(job: CronJob) {
  const state = makeState();
  state.store = { version: 1, jobs: [job] };
  recomputeNextRunsForMaintenance(state, { deferredNotifications: [], nowMs: ENDED_AT + 1_000 });
}

function expectSlot(job: CronJob, nextRunAtMs: number) {
  expect(job.state).toMatchObject({ nextRunAtMs, pacedNextRunAtMs: nextRunAtMs });
}

it.each(["recurring retry", "pacing"])(
  "auto-disables a job when %s cannot produce a Date-valid next run",
  (scenario) => {
    const endedAt = MAX_DATE_TIMESTAMP_MS - 1_000;
    const job = makeCronJob({
      schedule: { kind: "every", everyMs: 1_000, anchorMs: 0 },
      state: { nextRunAtMs: endedAt },
      ...(scenario === "pacing" ? { pacing: { min: "1s" } } : {}),
    });
    const retry = scenario === "recurring retry";
    const { state, deferredNotifications } = complete(job, {
      startedAt: endedAt - 1,
      endedAt,
      status: retry ? "error" : "ok",
      ...(retry
        ? {
            error: "temporary timeout",
            errorClassification: { kind: "reason" as const, reason: "timeout" as const },
            executionStarted: true,
          }
        : {}),
      ...(scenario === "pacing" ? { nextCheck: { delayMs: 2_000 } } : {}),
    });
    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.pacedNextRunAtMs).toBeUndefined();
    expect(job.state.autoDisabled).toEqual({
      reason: "schedule-errors",
      atMs: ENDED_AT,
      consecutiveErrors: 1,
    });
    expect(state.deps.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferredNotifications).toHaveLength(1);
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
  expect(job.enabled).toBe(false);
  expect(job.state.nextRunAtMs).toBeUndefined();
});

it.each([
  ["maximum-only clamp", { max: "4h" }, 6 * 3_600_000, 4 * 3_600_000, false],
  ["trigger floor after pacing clamp", { min: "1s", max: "2m" }, 1_000, 30_000, true],
] as const)("applies %s", (_label, pacing, delayMs, expectedDelay, trigger) => {
  const job = makePacedJob(pacing);
  if (trigger) {
    job.trigger = { script: "return true" };
  }
  complete(job, { nextCheck: { delayMs } });
  expectSlot(job, ENDED_AT + expectedDelay);
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
    authorCronRunCompletion(admittedJob, {
      jobId: job.id,
      job: admittedJob,
      status: "ok",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      triggerEval: { fired: false, stateChanged: false },
    }),
    { deferredNotifications: [] },
  );
  expectSlot(job, nextRunAtMs);
  expect(job.state.forcePreservedNextRunAtMs).toBe(forcePreservedNextRunAtMs);
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
