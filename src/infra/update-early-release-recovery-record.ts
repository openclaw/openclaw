import { VERSION } from "../version.js";
import type { SchemaVersions } from "./update-candidate-check-early-release.js";

/**
 * The early release recovery's update runs (see `update-early-release-recovery.ts`): opening one
 * under the release updater's lock, and recording the outcome for `openclaw update status`.
 * Loaded only by the runner and its finishing step, which run this release's code on migrated
 * state. Remove with it.
 */

export type RecoveryPlan = {
  /** The user service manager that runs the Gateway and this recovery. */
  supervisor: "systemd" | "launchd";
  /** The recovery's own job: a systemd unit name or a launchd label. */
  unit: string;
  /** launchd's GUI domain (`gui/<uid>`). */
  domain?: string;
  /** The file the launchd job writes its output to; systemd's goes to the journal. */
  log?: string;
  /** How the user reads the runner's output. */
  follow: string;
  checkout: string;
  branch: string;
  target: string;
  /** The release the updater built, kept here for the rebuild window. */
  release: string;
  prefix: string;
  stateDir: string;
  /** The unit file or LaunchAgent plist. */
  serviceFile: string;
  /** Every file of the Gateway's definition that existed when the recovery was planned, the
   * service file first; each is copied beside itself before the first switch. */
  definitionFiles: string[];
  /** The early updater's release link's target, restored when the previous build comes back. */
  legacyLink: string | null;
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
  const { finishUpdateRunAsync, recordUpdateRunStepAsync } =
    await import("./update-run-write.async.js");
  // Without a held run, take the lock as `hold` does: that settles an interrupted runner's run.
  const { runId, lock } =
    outcome.runId === undefined
      ? await openHeldRun(outcome.plan)
      : { runId: outcome.runId, lock: undefined };
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
    // A finishing child records its parent's run; only the acquiring process releases custody.
    if (lock?.acquired) {
      await lock.release();
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
    deadlineMs: LOCK_DEADLINE_MS,
  });
  try {
    if (lock.acquired && lock.reclaimedRunId) {
      // An interrupted runner's run; the Gateway would otherwise settle it at its next start.
      await finishUpdateRunAsync(lock.reclaimedRunId, { status: "failed", reason: "interrupted" });
    }
    return { runId, lock };
  } catch (error) {
    if (lock.acquired) {
      await lock.release();
    }
    throw error;
  }
}

/** The recovery run and its release capability, retained by the runner through finishing. */
export async function holdUpdateLock(plan: RecoveryPlan) {
  const { runId, lock } = await openHeldRun(plan);
  if (!lock.acquired) {
    const { finishUpdateRunAsync } = await import("./update-run-write.async.js");
    await finishUpdateRunAsync(runId, { status: "skipped", reason: "update-running" });
    return null;
  }
  return { runId, release: lock.release };
}
