// Regression coverage for #137215: a timed-out run whose original execution may
// still be running (an ignored abort) must keep its documented retry, and must
// not overlap that execution either. The run receipt is the single overlap
// fence: it holds the retry until the original settles, and the retry then runs.
//
// The cleanup request is not a termination fact. Whether it rejects, hangs past
// its guard, or resolves, retry eligibility stays intact; only the receipt
// settlement releases the fence.
import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createIsolatedRegressionJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { onTimer } from "./timer.test-support.js";

const FAST_TIMEOUT_SECONDS = 1;
const TIMEOUT_ADVANCE_MS = Math.ceil(FAST_TIMEOUT_SECONDS * 1_000) + 10;
// Mirrors CRON_TIMEOUT_CLEANUP_GUARD_MS; the lane stops waiting after this.
const CLEANUP_GUARD_ADVANCE_MS = 20_000 + 10;

const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-timeout-retry-settlement-",
});

function requireJob(state: { store?: { jobs?: CronJob[] } | null }, id: string): CronJob {
  const job = state.store?.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`expected cron job ${id}`);
  }
  return job;
}

function requireTimestamp(value: number | undefined, label: string): number {
  if (value === undefined) {
    throw new Error(`expected ${label} timestamp`);
  }
  return value;
}

function latestReceiptStatus(storePath: string, jobId: string): string | undefined {
  const row = openOpenClawStateDatabase()
    .db.prepare(
      "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
    )
    .get(cronStoreKey(storePath), jobId) as { status: string } | undefined;
  return row?.status;
}

/**
 * A job whose abort is ignored: the runner keeps running past its own timeout,
 * so the timed-out outcome is finalized while the execution is still live.
 */
function setupTimedOutRun(params: {
  job: CronJob;
  storePath: string;
  clock: { now: number };
  cleanup: () => Promise<void>;
}) {
  const runnerStarted = createDeferred();
  const releaseRunner = createDeferred<{ status: "ok"; summary: string }>();
  const runIsolatedAgentJob = vi.fn(async ({ onExecutionStarted }) => {
    onExecutionStarted?.();
    runnerStarted.resolve();
    return await releaseRunner.promise;
  });
  const state = createCronRegressionState({
    storePath: params.storePath,
    nowMs: () => params.clock.now,
    cleanupTimedOutAgentRun: vi.fn(params.cleanup),
    runIsolatedAgentJob,
  });
  return { state, runIsolatedAgentJob, runnerStarted, releaseRunner };
}

function makeIsolatedJob(params: {
  id: string;
  scheduledAt: number;
  schedule: CronJob["schedule"];
}): CronJob {
  return createIsolatedRegressionJob({
    id: params.id,
    name: params.id,
    scheduledAt: params.scheduledAt,
    schedule: params.schedule,
    payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
    state: { nextRunAtMs: params.scheduledAt },
  });
}

describe("cron timeout retry settlement fence", () => {
  it.each([
    { label: "cleanup rejects", mode: "reject" as const },
    { label: "cleanup outlives its guard", mode: "guard" as const },
  ])(
    "keeps a timed-out one-shot retry eligible when $label and runs it after settlement",
    async ({ mode }) => {
      vi.useFakeTimers();
      try {
        const store = timerRegressionFixtures.makeStorePath();
        const scheduledAt = Date.parse("2026-02-15T15:00:00.000Z");
        const job = makeIsolatedJob({
          id: `oneshot-timeout-retry-${mode}`,
          scheduledAt,
          schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
        });
        await saveCronStore(store.storePath, { version: 1, jobs: [job] });

        const clock = { now: scheduledAt };
        const { state, runIsolatedAgentJob, runnerStarted, releaseRunner } = setupTimedOutRun({
          job,
          storePath: store.storePath,
          clock,
          cleanup:
            mode === "reject"
              ? async () => {
                  throw new Error("cleanup backend unavailable");
                }
              : () => new Promise<void>(() => {}),
        });

        const timerPromise = onTimer(state);
        try {
          await runnerStarted.promise;
          await vi.advanceTimersByTimeAsync(TIMEOUT_ADVANCE_MS);
          clock.now += TIMEOUT_ADVANCE_MS;
          if (mode === "guard") {
            await vi.advanceTimersByTimeAsync(CLEANUP_GUARD_ADVANCE_MS);
            clock.now += CLEANUP_GUARD_ADVANCE_MS;
          }
          await timerPromise;

          const afterTimeout = requireJob(state, job.id);
          // The documented timeout retry survives: a one-shot job is not disabled
          // because its cleanup request could not prove termination.
          expect(afterTimeout.enabled).toBe(true);
          expect(afterTimeout.state.lastStatus).toBe("error");
          const retryAt = requireTimestamp(afterTimeout.state.nextRunAtMs, "retry next run");
          expect(retryAt).toBeGreaterThan(scheduledAt);
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

          // The original execution is still unsettled, so the receipt fences it.
          expect(latestReceiptStatus(store.storePath, job.id)).toBe("running");

          // The retry comes due while the original is still running: no overlap.
          clock.now = retryAt + 1;
          await onTimer(state);
          const fenced = requireJob(state, job.id);
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
          expect(fenced.enabled).toBe(true);
          expect(requireTimestamp(fenced.state.nextRunAtMs, "fenced retry")).toBe(retryAt);

          // The original finally settles; the retained retry runs.
          releaseRunner.resolve({ status: "ok", summary: "late original finished" });
          await vi.waitFor(() =>
            expect(latestReceiptStatus(store.storePath, job.id)).not.toBe("running"),
          );
          await onTimer(state);
          const settled = requireJob(state, job.id);
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
          expect(settled.state.lastStatus).toBe("ok");
          expect(settled.enabled).toBe(false);
        } finally {
          releaseRunner.resolve({ status: "ok", summary: "late original finished" });
          await Promise.allSettled([timerPromise]);
          await vi.waitFor(() =>
            expect(latestReceiptStatus(store.storePath, job.id)).not.toBe("running"),
          );
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a recurring job scheduled after a timeout whose original is still running", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T16:00:00.000Z");
      const job = makeIsolatedJob({
        id: "recurring-timeout-retry",
        scheduledAt,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt - 60_000 },
      });
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const clock = { now: scheduledAt };
      const { state, runIsolatedAgentJob, runnerStarted, releaseRunner } = setupTimedOutRun({
        job,
        storePath: store.storePath,
        clock,
        cleanup: () => new Promise<void>(() => {}),
      });

      const timerPromise = onTimer(state);
      try {
        await runnerStarted.promise;
        await vi.advanceTimersByTimeAsync(TIMEOUT_ADVANCE_MS + CLEANUP_GUARD_ADVANCE_MS);
        clock.now += TIMEOUT_ADVANCE_MS + CLEANUP_GUARD_ADVANCE_MS;
        await timerPromise;

        const afterTimeout = requireJob(state, job.id);
        // A timed-out recurring job keeps its normal schedule: no operator hold,
        // while the receipt still prevents an overlapping successor.
        expect(afterTimeout.enabled).toBe(true);
        expect(afterTimeout.state.lastStatus).toBe("error");
        const nextRunAtMs = requireTimestamp(afterTimeout.state.nextRunAtMs, "recurring next run");
        expect(nextRunAtMs).toBeGreaterThan(scheduledAt);
        expect(latestReceiptStatus(store.storePath, job.id)).toBe("running");

        // The schedule comes due while the original is still running.
        clock.now = nextRunAtMs + 1;
        await onTimer(state);
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        expect(requireJob(state, job.id).enabled).toBe(true);
        expect(latestReceiptStatus(store.storePath, job.id)).toBe("running");

        // After settlement the recurring job runs on its schedule again.
        releaseRunner.resolve({ status: "ok", summary: "late original finished" });
        await vi.waitFor(() =>
          expect(latestReceiptStatus(store.storePath, job.id)).not.toBe("running"),
        );
        await onTimer(state);
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
        expect(requireJob(state, job.id).enabled).toBe(true);
      } finally {
        releaseRunner.resolve({ status: "ok", summary: "late original finished" });
        await Promise.allSettled([timerPromise]);
        await vi.waitFor(() =>
          expect(latestReceiptStatus(store.storePath, job.id)).not.toBe("running"),
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
