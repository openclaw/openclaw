import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { markCronJobActive } from "../active-jobs.js";
import { cronScriptFailureMetadata } from "../script-failure.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronJob, CronRunOutcome } from "../types.js";
import { restoreFinalizedStartupRun } from "./startup-run-repair.js";
import { finalizeCompletedCronRunOutcomes } from "./timer-outcome-finalization.js";
import { applyJobResult, applyTriggerNoFireResult } from "./timer-outcomes.js";
import { authorCronRunCompletion } from "./timer.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-failure-alert-recovery-" });

function createFixture() {
  const store = fixtures.makeStorePath();
  const clock = { now: Date.parse("2026-08-01T15:00:00Z") };
  const job = createDueIsolatedJob({
    id: "recovery-monitor",
    nowMs: clock.now,
    nextRunAtMs: clock.now,
  });
  job.schedule = { kind: "every", everyMs: 60_000, anchorMs: clock.now };
  job.delivery = { mode: "none" };
  job.failureAlert = { after: 1, cooldownMs: 60_000 };
  const sendCronFailureAlert = vi.fn(async () => undefined);
  const state = createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => clock.now,
    sendCronFailureAlert,
    runIsolatedAgentJob: vi.fn(),
  });
  return { store, clock, job, state, sendCronFailureAlert };
}

async function finalize(
  context: ReturnType<typeof createFixture>,
  job: CronJob,
  result: CronRunOutcome,
) {
  await finalizeCompletedCronRunOutcomes(context.state, [
    {
      jobId: job.id,
      job: structuredClone(job),
      activeJobMarker: markCronJobActive(job.id),
      ...authorCronRunCompletion(context.state, job, result),
      startedAt: context.clock.now,
      endedAt: context.clock.now + 10,
    },
  ]);
}

describe("cron failure incident startup recovery", () => {
  it("reopens a recurring failure after replaying success whose job-row commit failed", async () => {
    const context = createFixture();
    const { store, clock, state, sendCronFailureAlert } = context;
    await saveCronStore(store.storePath, { version: 1, jobs: [context.job] });
    await finalize(context, context.job, { status: "error", error: "monitor failed" });
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    const pendingJob = (await loadCronStore(store.storePath)).jobs[0]!;
    clock.now += 1_000;
    pendingJob.state.runningAtMs = clock.now;
    await saveCronStore(store.storePath, { version: 1, jobs: [pendingJob] });
    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TEMP TRIGGER reject_recovered_cron_row
      BEFORE UPDATE ON cron_jobs
      WHEN NEW.store_key = '${cronStoreKey(store.storePath)}' AND NEW.job_id = '${pendingJob.id}'
      BEGIN
        SELECT RAISE(ABORT, 'recovery row write failed');
      END;
    `);
    try {
      await expect(finalize(context, pendingJob, { status: "ok" })).rejects.toThrow(
        "recovery row write failed",
      );
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_recovered_cron_row");
    }
    const entry = readCronTaskRunHistoryPage({
      storeKey: cronStoreKey(store.storePath),
      jobId: pendingJob.id,
      status: "ok",
    }).entries[0];
    if (!entry || entry.status !== "ok") {
      throw new Error("expected durable successful task history");
    }
    const staleJob = (await loadCronStore(store.storePath)).jobs[0]!;
    expect(staleJob.state.failureAlertIncident?.signature).toBeDefined();
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    const notifications: Array<() => void> = [];
    restoreFinalizedStartupRun({
      state,
      job: staleJob,
      runningAtMs: clock.now,
      entry: { ...entry, status: "ok" },
      deferredNotifications: notifications,
    });
    expect(notifications).toEqual([]);
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    expect(staleJob.state.failureAlertIncident).toBeUndefined();
    expect(staleJob.state.lastFailureAlertAtMs).toBeUndefined();
    await saveCronStore(store.storePath, { version: 1, jobs: [staleJob] });

    clock.now += 1_000;
    await finalize(context, staleJob, { status: "error", error: "monitor failed" });
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
  });

  it.each(["trigger", "payload"] as const)(
    "reconciles a quiet startup check after a %s failure without historical notifications",
    (source) => {
      const { state, job, clock, sendCronFailureAlert } = createFixture();
      applyJobResult(state, job, {
        status: "error",
        error: "plugin refresh failed",
        ...cronScriptFailureMetadata(source, "plugin_reload_failed"),
        startedAt: clock.now,
        endedAt: clock.now,
      });
      const notifications: Array<() => void> = [];
      restoreFinalizedStartupRun({
        state,
        job,
        runningAtMs: clock.now + 1_000,
        entry: {
          action: "finished",
          jobId: job.id,
          status: "ok",
          ts: clock.now + 1_001,
          runAtMs: clock.now + 1_000,
        },
        triggerEval: { fired: false, stateChanged: false },
        deferredNotifications: notifications,
      });
      expect(notifications).toEqual([]);
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(job.state.failureAlertIncident?.scope).toBe(source === "trigger" ? undefined : "run");
    },
  );

  it("keeps a replayed failure without script detail unresolved through a quiet trigger check", () => {
    const { state, job, clock, sendCronFailureAlert } = createFixture();
    applyJobResult(state, job, {
      status: "error",
      error: "plugin refresh failed",
      ...cronScriptFailureMetadata("trigger", "plugin_reload_failed"),
      startedAt: clock.now,
      endedAt: clock.now,
    });
    const notifications: Array<() => void> = [];
    restoreFinalizedStartupRun({
      state,
      job,
      runningAtMs: clock.now + 1_000,
      entry: {
        action: "finished",
        jobId: job.id,
        status: "error",
        error: "script failed",
        ts: clock.now + 1_001,
        runAtMs: clock.now + 1_000,
      },
      deferredNotifications: notifications,
    });
    applyTriggerNoFireResult(
      state,
      job,
      {
        startedAt: clock.now + 2_000,
        endedAt: clock.now + 2_001,
        triggerEval: { fired: false, stateChanged: false },
      },
      { deferredNotifications: notifications },
    );
    expect(notifications).toEqual([]);
    expect(job.state.failureAlertIncident?.scope).toBe("run");
    expect(sendCronFailureAlert).toHaveBeenCalledOnce();
  });
});
