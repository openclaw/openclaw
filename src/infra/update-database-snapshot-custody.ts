import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { buildBackupArchivePath } from "./backup-archive-path-policy.js";
import { formatErrorMessage } from "./errors.js";
import { isNeverActivatedFailedUpdate } from "./update-run-activation.js";
import { listUpdateRuns } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { inspectUpdateRecoveries } from "./update-run-recovery.js";

// Long enough for an operator to act on a recovery warning. After this many days of
// new writes, restoring a pre-update copy would lose more than it recovers.
const MANUAL_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type DatabaseSnapshotDecision = { keep: string } | { remove: string };
export type DecideDatabaseSnapshot = (directory: string, ageMs: number) => DatabaseSnapshotDecision;

/**
 * A snapshot is pre-migration data, so it stays until its update's outcome no longer needs it:
 * verified activation, an update that never activated, or a later successful update once
 * manual recovery has had its window. Without a matching run only age can release it.
 */
export function decideDatabaseSnapshot(
  directory: string,
  ageMs: number,
  runs: readonly UpdateRunRecord[],
  holdsThisStateDatabase: boolean,
  now = Date.now(),
): DatabaseSnapshotDecision {
  // Only the capture receipt identifies the owning run. Later runs also mention this path
  // when their cleanup reports keeping it, and their outcome says nothing about its data.
  const capture = `Databases snapshotted at ${directory}.`;
  const run = runs.find((candidate) =>
    candidate.steps.some((step) => step.detail?.startsWith(capture)),
  );
  const window = `its ${MANUAL_RECOVERY_RETENTION_MS / (24 * 60 * 60 * 1000)}-day recovery window has not ended`;
  if (!run && !holdsThisStateDatabase) {
    // Several state directories can share a checkout, and another one's history is not
    // readable from here. Its own next update decides this copy.
    return {
      keep: "no update run in this state directory records it, and it holds no copy of this state's database",
    };
  }
  if (!run) {
    return ageMs >= MANUAL_RECOVERY_RETENTION_MS
      ? { remove: "no update run records it, and its recovery window has ended" }
      : { keep: `no update run records it, and ${window}` };
  }
  if (run.finishedAtMs === null) {
    return { keep: `update run ${run.runId} is still in progress` };
  }
  if (run.status === "skipped" || isNeverActivatedFailedUpdate(run)) {
    return {
      remove: `update run ${run.runId} did not activate, so its databases were not replaced`,
    };
  }
  const windowEnded = now - run.finishedAtMs >= MANUAL_RECOVERY_RETENTION_MS;
  if (run.status === "succeeded") {
    // These two warnings are how a run says restoration was refused and the copy is manual recovery.
    const manual = run.steps.some(
      (step) =>
        step.detail?.includes(directory) &&
        /restoration (?:is disabled|unavailable)/u.test(step.detail),
    );
    return manual && !windowEnded
      ? { keep: `update run ${run.runId} retained it for manual recovery, and ${window}` }
      : { remove: `update run ${run.runId} succeeded and no longer needs it` };
  }
  const resolved = runs.some(
    (later) =>
      later.status === "succeeded" &&
      later.finishedAtMs !== null &&
      later.finishedAtMs > (run.finishedAtMs ?? 0),
  );
  return resolved && windowEnded
    ? {
        remove: `an update after failed run ${run.runId} succeeded, and its recovery window has ended`,
      }
    : {
        keep: `recovery from update run ${run.runId} may need it; a later successful update or openclaw update repair releases it`,
      };
}

/** Facts are read once per sweep. If they cannot be read, every snapshot stays this pass. */
export function readDatabaseSnapshotCustody(env: NodeJS.ProcessEnv): DecideDatabaseSnapshot {
  try {
    // Manifests of a pending recovery can name these paths in forms this check cannot
    // compare, and nothing should shrink the recovery set until that recovery settles.
    if (inspectUpdateRecoveries({ env }).some(({ record }) => isUpdateRecoveryPending(record))) {
      return () => ({ keep: "an update recovery is still pending" });
    }
    const runs = listUpdateRuns({}, { env });
    const stateDatabase = buildBackupArchivePath("", resolveOpenClawStateSqlitePath(env));
    return (directory, ageMs) =>
      decideDatabaseSnapshot(
        directory,
        ageMs,
        runs,
        existsSync(path.join(directory, stateDatabase)),
      );
  } catch (error) {
    const reason = `update history could not be read: ${formatErrorMessage(error)}`;
    return () => ({ keep: reason });
  }
}
