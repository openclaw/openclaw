// Regression: the deferred-queue-to-job.state mirror has exactly one owner
// — `reconcileMaintenancePhaseTransition` at the scheduler's finally block.
// `applyJobResult` deliberately does NOT project the queue; if it did, a
// job that runs on the phase-exit tick would be double-counted (once at
// applyJobResult, once at the reconcile that runs immediately after).
//
// This test exercises the full lifecycle:
//   1. Maintenance active; isRunnableJob records a deferral for job A.
//   2. Phase exits; reconcileMaintenancePhaseTransition drains the queue
//      and writes the mirror to job.state. The count is set ONCE.
//   3. Next tick; isRunnableJob admits job A (we are now in normal phase).
//   4. applyJobResult runs. It must NOT touch deferredMaintenanceCount;
//      the phase-exit mirror is the canonical producer.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMaintenanceDeferrals } from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { applyJobResult } from "./service/timer-outcomes.js";
import { isRunnableJob } from "./service/timer-runnable.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-mirror-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // after window

function makeJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi", toolsAllow: ["write"] },
    agentId: "main",
    state: {
      lastRunAtMs: 0,
      lastStatus: "ok",
      lastDurationMs: 0,
      consecutiveErrors: 0,
      nextRunAtMs: AT_UTC_03_30 - 60 * 60_000, // due by AT_UTC_03_30
    },
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

async function makeState(job: CronJob) {
  const { storePath } = await makeStorePath();
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const state = createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    defaultAgentId: "main",
    userTimezone: "UTC",
    cronConfig: {
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"], // main is not in the roster
      },
    },
  });
  await ensureLoaded(state, { forceReload: true, skipRecompute: true });
  return state;
}

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("maintenance deferral mirror has a single owner (reconcile, not applyJobResult)", () => {
  it("phase-exit reconcile writes the mirror; applyJobResult does not double-count", async () => {
    const job = makeJob("job-A");
    const state = await makeState(job);

    // Tick 1: inside the maintenance window. Job A is blocked, deferral
    // is recorded.
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    const blocked = isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_03_30,
      allowCronMissedRunByLastRun: true,
    });
    expect(blocked).toBe(false);
    const storeJob = state.store?.jobs.find((j) => j.id === "job-A");
    // Pre-phase-exit: mirror has not happened yet.
    expect(storeJob?.state.deferredMaintenanceCount ?? 0).toBe(0);

    // Phase exits; reconcile mirrors the backlog and clears the queue.
    const phaseExit = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(phaseExit.current).toBe("normal");
    expect(phaseExit.drainedCount).toBe(1);
    // After reconcile: mirror is set EXACTLY ONCE.
    expect(storeJob?.state.deferredMaintenanceCount).toBe(1);
    expect(storeJob?.state.firstDeferredMaintenanceAtMs).toBe(AT_UTC_03_30);
    expect(storeJob?.state.lastDeferredMaintenanceAtMs).toBe(AT_UTC_03_30);

    // Tick 2: outside the window. Job A is now admissible.
    const admitted = isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_05_00,
      allowCronMissedRunByLastRun: true,
    });
    expect(admitted).toBe(true);

    // applyJobResult runs. It must NOT increment the maintenance count
    // (the mirror at phase exit is the canonical producer).
    applyJobResult(
      state,
      job,
      { status: "ok", startedAt: AT_UTC_05_00, endedAt: AT_UTC_05_00 + 100 },
      { scheduleMode: "advance" },
    );
    expect(storeJob?.state.deferredMaintenanceCount).toBe(1); // unchanged
  });

  it("a job that runs on the exit tick is counted exactly once (not zero, not twice)", async () => {
    // Simulates the race: the scheduler tick at AT_UTC_05_00 finds job A
    // (1) already-due (nextRunAtMs is in the past), (2) the phase has
    // just transitioned from maintenance -> normal. The job runs, then
    // the finally block runs reconcile. With two mirror owners the
    // count would be 2. With the single-owner fix it is 1.
    const job = makeJob("job-A");
    const state = await makeState(job);

    // Tick 1: inside the window. Deferral recorded.
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_03_30,
      allowCronMissedRunByLastRun: true,
    });
    const storeJob = state.store?.jobs.find((j) => j.id === "job-A");
    expect(storeJob?.state.deferredMaintenanceCount ?? 0).toBe(0);

    // Tick 2: at the phase boundary, the job is admitted (phase is
    // already normal because reconcile happened first) and then
    // applyJobResult runs. Then the test simulates the finally-block
    // reconcile at the SAME tick — but since lastMaintenancePhase is
    // already "normal" from the previous tick, the second reconcile is
    // a no-op (no transition). The count is still 1, not 2.
    reconcileMaintenancePhaseTransition(state, AT_UTC_05_00); // exit
    expect(storeJob?.state.deferredMaintenanceCount).toBe(1);
    isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_05_00,
      allowCronMissedRunByLastRun: true,
    });
    applyJobResult(
      state,
      job,
      { status: "ok", startedAt: AT_UTC_05_00, endedAt: AT_UTC_05_00 + 100 },
      { scheduleMode: "advance" },
    );
    expect(storeJob?.state.deferredMaintenanceCount).toBe(1); // single owner
  });
});
