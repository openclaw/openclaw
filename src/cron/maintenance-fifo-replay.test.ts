// Regression for ClawSweeper cycle 4 [P1] "Replay the deferred backlog
// instead of clearing it". The previous design snapshot the queue,
// mirrored the per-job diagnostics, and cleared the queue — but never
// re-ran any of the held work. The next scheduler tick relied on the
// normal admission path; a job whose `nextRunAtMs` had advanced past
// the window exit was silently lost.
//
// This test exercises the contract end-to-end:
//   1. Three jobs across two agents are due before the maintenance window.
//   2. All three are deferred in A -> B -> C order during the window.
//   3. Phase exits. The reconcile (a) mirrors the diagnostics, (b) resets
//      each job's `nextRunAtMs` to a replay anchor, (c) clears the queue.
//   4. Next tick: all three jobs are admitted in A -> B -> C FIFO order,
//      not in store order. They actually run.
//   5. The per-job mirror is preserved (deferredMaintenanceCount == 1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginMaintenancePhase,
  getMaintenanceDeferralCount,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
} from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { collectRunnableJobs } from "./service/timer-runnable.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-fifo-replay-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // after window

function makeJob(id: string, agentId: string, dueAtMs: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi", toolsAllow: ["write"] },
    agentId,
    state: {
      lastRunAtMs: 0,
      lastStatus: "ok",
      lastDurationMs: 0,
      consecutiveErrors: 0,
      nextRunAtMs: dueAtMs,
    },
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

async function makeState(jobs: CronJob[]) {
  const { storePath } = await makeStorePath();
  await writeCronStoreSnapshot({ storePath, jobs });
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
        maintenanceAgents: ["ops"], // main + secondary are deferred
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

describe("phase-exit FIFO replay", () => {
  it("defers A, B, C in that order; phase exit replays them in that order", async () => {
    // Use a non-natural store order: C is job[0], A is job[1], B is job[2].
    // The replay must still come out A -> B -> C.
    const jobC = makeJob("job-C", "main", AT_UTC_03_30 - 60_000);
    const jobA = makeJob("job-A", "main", AT_UTC_03_30 - 60_000);
    const jobB = makeJob("job-B", "secondary", AT_UTC_03_30 - 60_000);
    const state = await makeState([jobC, jobA, jobB]);

    // Tick 1: inside the window. Phase is maintenance, all three are
    // deferred in A -> B -> C order via the public record path. The
    // store order does not matter — FIFO is bound to the deferral order.
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "main", nowMs: AT_UTC_03_30 });
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "secondary", nowMs: AT_UTC_03_30 + 1 });
    recordMaintenanceDeferral({ jobId: "job-C", agentId: "main", nowMs: AT_UTC_03_30 + 2 });
    expect(getMaintenanceDeferralCount()).toBe(3);

    // Phase exits. Replay happens here.
    const phaseExit = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(phaseExit.current).toBe("normal");
    expect(phaseExit.drainedCount).toBe(3);
    expect(getMaintenanceDeferralCount()).toBe(0);

    // The store copy of each job is the canonical state. Reference it
    // for the diagnostics assertion.
    const storeA = state.store?.jobs.find((j) => j.id === "job-A");
    const storeB = state.store?.jobs.find((j) => j.id === "job-B");
    const storeC = state.store?.jobs.find((j) => j.id === "job-C");
    expect(storeA?.state.deferredMaintenanceCount).toBe(1);
    expect(storeB?.state.deferredMaintenanceCount).toBe(1);
    expect(storeC?.state.deferredMaintenanceCount).toBe(1);
    // Replay anchor: each job's nextRunAtMs is in the past so the next
    // tick admits it.
    expect(storeA?.state.nextRunAtMs).toBeLessThanOrEqual(AT_UTC_05_00 - 1);
    expect(storeB?.state.nextRunAtMs).toBeLessThanOrEqual(AT_UTC_05_00 - 1);
    expect(storeC?.state.nextRunAtMs).toBeLessThanOrEqual(AT_UTC_05_00 - 1);

    // Next tick: all three are runnable, and they come out in A -> B -> C
    // order (FIFO by deferral timestamp), NOT in store order (C, A, B).
    const admitted = collectRunnableJobs(state, AT_UTC_05_00, {
      allowCronMissedRunByLastRun: true,
    });
    expect(admitted.map((j) => j.id)).toEqual(["job-A", "job-B", "job-C"]);
  });

  it("replay anchor only moves nextRunAtMs backwards (never forwards)", async () => {
    // A job whose nextRunAtMs is already earlier than the replay anchor
    // (e.g. it's already overdue) must keep its earlier anchor. The
    // replay must not artificially push a job into the future.
    const job = makeJob("job-overdue", "main", AT_UTC_03_30 - 60_000);
    const state = await makeState([job]);
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordMaintenanceDeferral({
      jobId: "job-overdue",
      agentId: "main",
      nowMs: AT_UTC_03_30,
    });
    const phaseExit = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(phaseExit.drainedCount).toBe(1);
    const storeJob = state.store?.jobs.find((j) => j.id === "job-overdue");
    // Original nextRunAtMs was AT_UTC_03_30 - 60_000. The replay anchor
    // is Math.max(AT_UTC_03_30, AT_UTC_05_00 - 1) = AT_UTC_03_30. The
    // original was earlier, so it must be preserved.
    expect(storeJob?.state.nextRunAtMs).toBe(AT_UTC_03_30 - 60_000);
  });

  it("a non-deferred job with the same nextRunAtMs sorts after deferred jobs", async () => {
    // A non-deferred job that happens to be due must sort after any
    // deferred jobs (which have the right of way on the replay tick).
    const deferred = makeJob("job-def", "main", AT_UTC_03_30 - 60_000);
    const fresh = makeJob("job-fresh", "main", AT_UTC_03_30 - 60_000);
    const state = await makeState([fresh, deferred]);
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordMaintenanceDeferral({ jobId: "job-def", agentId: "main", nowMs: AT_UTC_03_30 });
    reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    // job-fresh is still on the in-roster path (main is not in roster
    // so it would also defer). Force it to not be deferred by tweaking
    // the test: change its agent to ops so it never defers.
    const storeFresh = state.store?.jobs.find((j) => j.id === "job-fresh");
    if (storeFresh) {
      storeFresh.agentId = "ops";
    }
    const admitted = collectRunnableJobs(state, AT_UTC_05_00, {
      allowCronMissedRunByLastRun: true,
    });
    // job-def has lastDeferredMaintenanceAtMs; job-fresh doesn't. The
    // deferred one must come first.
    expect(admitted[0]?.id).toBe("job-def");
    expect(admitted[admitted.length - 1]?.id).toBe("job-fresh");
  });

  it("an empty replay (no held entries) is a no-op", async () => {
    // Phase re-enters and re-exits without any deferrals. The drain
    // count is 0, the per-job state is untouched, and the queue stays
    // empty across the cycle.
    const job = makeJob("job-A", "ops", AT_UTC_03_30 - 60_000); // in-roster
    const state = await makeState([job]);
    const tEnter = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    expect(tEnter.current).toBe("maintenance");
    const tExit = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(tExit.drainedCount).toBe(0);
    expect(getMaintenanceDeferralCount()).toBe(0);
    const storeJob = state.store?.jobs.find((j) => j.id === "job-A");
    expect(storeJob?.state.deferredMaintenanceCount ?? 0).toBe(0);
  });
});
