import { VERSION } from "../version.js";
import type { SchemaVersions } from "./update-candidate-check-early-release.js";

/**
 * The early release recovery's update runs (see `update-early-release-recovery.ts`): opening one
 * under the release updater's lock, and recording the outcome for `openclaw update status`.
 * Loaded only by the runner and its finishing step, which run this release's code on migrated
 * state. Remove with it.
 */

export type RecoveryPlan = {
  unit: string;
  checkout: string;
  branch: string;
  target: string;
  /** The release the updater built, kept here for the rebuild window. */
  release: string;
  prefix: string;
  serviceFile: string;
  /** `systemctl --user is-enabled` of the Gateway service when the recovery was planned. */
  enabled: string;
  /** Every store's schema version when the recovery was planned. */
  schema: SchemaVersions;
  fromVersion: string;
  driver: { pid: number; start: string };
  /** When `--check` planned this recovery (epoch milliseconds). */
  plannedAt: number;
};

export type RecoveryOutcome = {
  plan: RecoveryPlan;
  runId?: string;
  status: "succeeded" | "failed";
  reason: string;
  detail: string;
  nextAction?: string;
  downtimeMs?: number;
};

/** The runner's install and build (an hour each at most) and both Gateway switches. */
const LOCK_DEADLINE_MS = 3 * 60 * 60_000;

export async function recordOutcome(outcome: RecoveryOutcome) {
  const [{ finishUpdateRunAsync, recordUpdateRunStepAsync }, store] = await Promise.all([
    import("./update-run-write.async.js"),
    import("../update/store.js"),
  ]);
  // Without a held run, take the lock as `hold` does: that settles an interrupted runner's run.
  const runId = outcome.runId ?? (await openHeldRun(outcome.plan)).runId;
  try {
    await recordUpdateRunStepAsync(runId, {
      step: "early-release-recovery",
      status: outcome.status === "succeeded" ? "completed" : "failed",
      endedAtMs: Date.now(),
      detail: outcome.detail,
    });
    await finishUpdateRunAsync(runId, {
      status: outcome.status,
      reason: outcome.reason,
      ...(outcome.nextAction ? { nextAction: outcome.nextAction } : {}),
      ...(outcome.status === "succeeded"
        ? { after: { version: VERSION, sha: outcome.plan.target } }
        : {}),
      ...(outcome.downtimeMs === undefined ? {} : { downtimeMs: outcome.downtimeMs }),
    });
  } finally {
    // Held by this runner, or by the runner that started this finishing step.
    const holder = (await store.readUpdateLock())?.pid;
    if (holder === process.pid || holder === process.ppid) {
      await store.releaseUpdateLock();
    }
  }
}

async function openRun(plan: RecoveryPlan): Promise<string> {
  const [{ createUpdateRunAsync }, { getUpdateRunStatusAsync }] = await Promise.all([
    import("./update-run-write.async.js"),
    import("./update-run-reader.js"),
  ]);
  // The trigger of the run the early updater recorded before the check planned this recovery:
  // `api` for an update the Gateway started. The recovery finishes that update.
  const { lastRun } = await getUpdateRunStatusAsync();
  const target = { kind: "git" as const, version: VERSION, sha: plan.target };
  const run = await createUpdateRunAsync({
    trigger: lastRun && lastRun.createdAtMs <= plan.plannedAt ? lastRun.trigger : "cli",
    target,
    before: { version: plan.fromVersion },
  });
  return run.runId;
}

/** A new run for this recovery, holding the release updater's lock unless another update does. */
async function openHeldRun(plan: RecoveryPlan) {
  const [{ finishUpdateRunAsync }, store] = await Promise.all([
    import("./update-run-write.async.js"),
    import("../update/store.js"),
  ]);
  const runId = await openRun(plan);
  const lock = await store.acquireUpdateLock({
    runId,
    pid: process.pid,
    deadlineMs: LOCK_DEADLINE_MS,
  });
  if (lock.acquired && lock.previous) {
    // An interrupted runner's run; the Gateway would otherwise settle it at its next start.
    await finishUpdateRunAsync(lock.previous.runId, { status: "failed", reason: "interrupted" });
  }
  return { runId, acquired: lock.acquired };
}

/** The release updater's lock, held by this runner's update run until its outcome is recorded. */
export async function holdUpdateLock(plan: RecoveryPlan): Promise<string | null> {
  const { runId, acquired } = await openHeldRun(plan);
  if (!acquired) {
    const { finishUpdateRunAsync } = await import("./update-run-write.async.js");
    await finishUpdateRunAsync(runId, { status: "skipped", reason: "update-running" });
    return null;
  }
  return runId;
}
