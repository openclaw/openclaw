// Regression tests for #91944: cron schedule update follow by restart
// incorrectly classifies pre-update slots as "missed" during catch-up.
import { describe, expect, it } from "vitest";
import {
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { saveCronStore } from "../store.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { runMissedJobs } from "./timer.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-91944-catchup-",
});

/** Returns a timestamp for a given UTC date-time string. */
function ts(iso: string) {
  return Date.parse(iso);
}

/** Narrows the store type back after state.store = null + re-load. */
function storeJobs(state: { store?: CronStoreFile | null }): CronJob[] {
  const s = state.store as CronStoreFile | null;
  return s?.jobs ?? [];
}

describe("cron update catch-up guard (#91944)", () => {
  // The reporter scenario: monthly cron changed from day-10 to day-11.
  // After update, restart at ~June 10 should NOT treat May 11 as a
  // "missed" slot — that slot was computed from the new expression and
  // was never intended to execute under the old schedule.
  const OLD_SCHEDULE_LAST_RUN = ts("2026-05-10T15:18:00.000Z");
  const SCHEDULE_UPDATED_AT = ts("2026-06-09T22:30:00.000Z");
  const RESTART_AT = ts("2026-06-10T12:33:00.000Z");
  const CORRECT_NEXT_RUN = ts("2026-06-11T15:18:00.000Z");

  const cronSchedule = {
    kind: "cron" as const,
    expr: "18 15 11 * *",
    tz: "Asia/Shanghai",
  };

  it("skips inferred missed slot that predates the schedule update", async () => {
    // Job whose schedule was updated from day-10 to day-11.
    // lastRunAtMs = May 10 (old schedule execution).
    // previousRunAtMs computed from new expr = May 11 15:18 (predates update).
    // scheduleUpdatedAtMs set at update time → guard must skip this slot.
    const store = fixtures.makeStorePath();
    const job = createIsolatedRegressionJob({
      id: "updated-cron",
      name: "updated cron",
      scheduledAt: OLD_SCHEDULE_LAST_RUN,
      schedule: cronSchedule,
      payload: { kind: "agentTurn", message: "monthly report" },
      state: {
        lastRunAtMs: OLD_SCHEDULE_LAST_RUN,
        nextRunAtMs: CORRECT_NEXT_RUN,
        lastRunStatus: "ok",
        scheduleUpdatedAtMs: SCHEDULE_UPDATED_AT,
      },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => RESTART_AT,
      jobs: [job],
    });

    // Reload from disk so the state matches a real restart.
    state.store = null;
    await runMissedJobs(state);

    // Job must NOT have been classified as missed and must NOT have run.
    const reloaded = storeJobs(state).find((j) => j.id === "updated-cron");
    expect(reloaded).toBeDefined();
    expect(reloaded?.state.runningAtMs).toBeUndefined();
    expect(reloaded?.state.nextRunAtMs).toBe(CORRECT_NEXT_RUN);
    expect(reloaded?.state.lastRunAtMs).toBe(OLD_SCHEDULE_LAST_RUN);
  });

  it("still catches truly missed slots (no schedule update)", async () => {
    // Same scenario but WITHOUT scheduleUpdatedAtMs — the slot should
    // be treated as genuinely missed (previousRunAtMs > lastRunAtMs).
    const store = fixtures.makeStorePath();
    const oldLastRun = ts("2026-05-10T15:18:00.000Z");
    // nextRunAtMs already in the past → genuinely missed.
    const missedNextRun = ts("2026-06-10T14:00:00.000Z");
    const restartAt = ts("2026-06-10T15:00:00.000Z");

    const job = createIsolatedRegressionJob({
      id: "missed-cron",
      name: "missed cron",
      scheduledAt: oldLastRun,
      schedule: cronSchedule,
      payload: { kind: "agentTurn", message: "missed run" },
      state: {
        lastRunAtMs: oldLastRun,
        nextRunAtMs: missedNextRun,
        lastRunStatus: "ok",
        // No scheduleUpdatedAtMs — this is a genuine missed slot.
      },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => restartAt,
      jobs: [job],
    });

    state.store = null;
    await runMissedJobs(state);

    // Job SHOULD have been classified as missed and queued for execution.
    const reloaded = storeJobs(state).find((j) => j.id === "missed-cron");
    expect(reloaded).toBeDefined();
    // nextRunAtMs advanced past the missed slot, or job is marked running.
    const wasMissed =
      typeof reloaded?.state.runningAtMs === "number" ||
      (typeof reloaded?.state.nextRunAtMs === "number" &&
        reloaded.state.nextRunAtMs > missedNextRun);
    expect(wasMissed).toBe(true);
  });

  it("skips deferred-backoff slot that predates schedule update", async () => {
    // When a job is in error backoff and the schedule was updated,
    // deferPendingBackoffMissedCronSlots must not override nextRunAtMs
    // with a backoff target for a pre-update slot.
    const store = fixtures.makeStorePath();
    const restartAt = ts("2026-06-10T12:33:00.000Z");

    const job = createIsolatedRegressionJob({
      id: "backoff-updated-cron",
      name: "backoff updated cron",
      scheduledAt: OLD_SCHEDULE_LAST_RUN,
      schedule: cronSchedule,
      payload: { kind: "agentTurn", message: "monthly report" },
      state: {
        lastRunAtMs: OLD_SCHEDULE_LAST_RUN,
        nextRunAtMs: CORRECT_NEXT_RUN,
        lastRunStatus: "error",
        consecutiveErrors: 2,
        scheduleUpdatedAtMs: SCHEDULE_UPDATED_AT,
      },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => restartAt,
      jobs: [job],
    });

    state.store = null;
    await runMissedJobs(state);

    const reloaded = storeJobs(state).find((j) => j.id === "backoff-updated-cron");
    expect(reloaded).toBeDefined();
    // nextRunAtMs must NOT have been clobbered to backoffUntilMs for a
    // pre-update slot.
    expect(reloaded?.state.nextRunAtMs).toBe(CORRECT_NEXT_RUN);
  });

  it("preserves backward compatibility for jobs without scheduleUpdatedAtMs", async () => {
    // Jobs created before this fix (no scheduleUpdatedAtMs field) must
    // still go through normal catch-up logic.
    const store = fixtures.makeStorePath();
    const oldLastRun = ts("2026-05-10T15:18:00.000Z");
    const missedNextRun = ts("2026-06-10T14:00:00.000Z");
    const restartAt = ts("2026-06-10T15:00:00.000Z");

    const job = createIsolatedRegressionJob({
      id: "legacy-cron",
      name: "legacy cron",
      scheduledAt: oldLastRun,
      schedule: {
        kind: "cron",
        expr: "18 15 10 * *",
        tz: "Asia/Shanghai",
      },
      payload: { kind: "agentTurn", message: "legacy monthly" },
      state: {
        lastRunAtMs: oldLastRun,
        nextRunAtMs: missedNextRun,
        lastRunStatus: "ok",
        // No scheduleUpdatedAtMs — legacy job predates this fix.
      },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => restartAt,
      jobs: [job],
    });

    state.store = null;
    await runMissedJobs(state);

    const reloaded = storeJobs(state).find((j) => j.id === "legacy-cron");
    expect(reloaded).toBeDefined();
    // Legacy jobs without scheduleUpdatedAtMs must still be caught up.
    const wasMissed =
      typeof reloaded?.state.runningAtMs === "number" ||
      (typeof reloaded?.state.nextRunAtMs === "number" &&
        reloaded.state.nextRunAtMs > missedNextRun);
    expect(wasMissed).toBe(true);
  });

  it("allows missed slot that postdates the schedule update", async () => {
    // If the previousRunAtMs is >= scheduleUpdatedAtMs, the slot should
    // still be considered missed (it occurred after the update).
    const store = fixtures.makeStorePath();
    // Last run was under the OLD schedule (day 10, May).
    // Schedule was updated BEFORE that old last run — so the update
    // happened a while ago and the next missed slot is genuine.
    const oldLastRun = ts("2026-06-10T15:18:00.000Z");
    const scheduleUpdatedLongAgo = ts("2026-05-01T00:00:00.000Z");
    const missedNextRun = ts("2026-06-10T15:20:00.000Z");
    const restartAt = ts("2026-06-10T16:00:00.000Z");

    const job = createIsolatedRegressionJob({
      id: "genuine-missed-after-update",
      name: "genuine missed after update",
      scheduledAt: oldLastRun,
      schedule: { kind: "cron", expr: "18 15 * * *", tz: "UTC" },
      payload: { kind: "agentTurn", message: "daily report" },
      state: {
        lastRunAtMs: oldLastRun,
        nextRunAtMs: missedNextRun,
        lastRunStatus: "ok",
        scheduleUpdatedAtMs: scheduleUpdatedLongAgo,
      },
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => restartAt,
      jobs: [job],
    });

    state.store = null;
    await runMissedJobs(state);

    const reloaded = state.store?.jobs?.find(
      (j) => j.id === "genuine-missed-after-update",
    );
    expect(reloaded).toBeDefined();
    // This slot postdates the update, so it should still be caught.
    const wasMissed =
      typeof reloaded?.state.runningAtMs === "number" ||
      (typeof reloaded?.state.nextRunAtMs === "number" &&
        reloaded.state.nextRunAtMs > missedNextRun);
    expect(wasMissed).toBe(true);
  });
});
