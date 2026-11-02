import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { buildBackupArchivePath } from "./backup-archive-path-policy.js";
import { formatErrorMessage } from "./errors.js";
import { isNeverActivatedFailedUpdate } from "./update-run-activation.js";
import { findUpdateRunsMentioning, listUpdateRuns } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { inspectUpdateRecoveries } from "./update-run-recovery.js";

// Long enough for an operator to act on a recovery warning. After this many days of
// new writes, restoring a pre-update copy would lose more than it recovers.
const MANUAL_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_MARKER = ".openclaw-update-";

export type DatabaseSnapshotDecision = { keep: string } | { remove: string };
export type DecideDatabaseSnapshot = (directory: string, ageMs: number) => DatabaseSnapshotDecision;

/** What the whole update history says about one snapshot. */
export type DatabaseSnapshotHistory = {
  /** The run whose capture receipt names this snapshot, if any run does. */
  capture?: UpdateRunRecord;
  /** The most recently started successful update. */
  latestSuccess?: UpdateRunRecord;
};

/**
 * The capture receipt is the first database snapshot diagnostic. The ledger stores it with
 * home and state roots redacted, so only the snapshot's name is compared, which is unique.
 */
function isCaptureReceipt(run: UpdateRunRecord, name: string): boolean {
  return run.steps.some(
    (step) =>
      step.step === "diagnostic:database snapshot" &&
      step.detail?.startsWith("Databases snapshotted at ") === true &&
      step.detail.includes(`${name}. `),
  );
}

/**
 * A snapshot is pre-migration data, so it stays until its update's outcome no longer needs it:
 * verified activation, an update that never activated, or a later successful update once
 * manual recovery has had its window. Without history that shows its run, it stays.
 */
export function decideDatabaseSnapshot(
  directory: string,
  ageMs: number,
  history: DatabaseSnapshotHistory | undefined,
  holdsThisStateDatabase: boolean,
  now = Date.now(),
): DatabaseSnapshotDecision {
  if (!history) {
    return { keep: "update history cannot show which run captured it" };
  }
  const run = history.capture;
  const window = `its ${MANUAL_RECOVERY_RETENTION_MS / (24 * 60 * 60 * 1000)}-day recovery window has not ended`;
  if (!run && !holdsThisStateDatabase) {
    // Several state directories can share a checkout, and another one's history is not
    // readable from here. Its own next update decides this copy.
    return {
      keep: "no update run in this state directory records it, and it holds no copy of this state's database",
    };
  }
  if (!run) {
    // The whole history was searched, so this capture never reached its receipt.
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
    const name = path.basename(directory);
    const manual = run.steps.some(
      (step) =>
        step.detail?.includes(name) && /restoration (?:is disabled|unavailable)/u.test(step.detail),
    );
    return manual && !windowEnded
      ? { keep: `update run ${run.runId} retained it for manual recovery, and ${window}` }
      : { remove: `update run ${run.runId} succeeded and no longer needs it` };
  }
  const later = history.latestSuccess?.finishedAtMs;
  return later !== undefined && later !== null && later > run.finishedAtMs && windowEnded
    ? {
        remove: `an update after failed run ${run.runId} succeeded, and its recovery window has ended`,
      }
    : {
        keep: `recovery from update run ${run.runId} may need it; a later successful update or openclaw update repair releases it`,
      };
}

/** Each snapshot is looked up across the whole history; any failure keeps it this pass. */
export function readDatabaseSnapshotCustody(env: NodeJS.ProcessEnv): DecideDatabaseSnapshot {
  try {
    // Manifests of a pending recovery can name these paths in forms this check cannot
    // compare, and nothing should shrink the recovery set until that recovery settles.
    if (inspectUpdateRecoveries({ env }).some(({ record }) => isUpdateRecoveryPending(record))) {
      return () => ({ keep: "an update recovery is still pending" });
    }
    const latestSuccess = listUpdateRuns({ succeeded: true, limit: 1 }, { env })[0];
    const stateDatabase = buildBackupArchivePath("", resolveOpenClawStateSqlitePath(env));
    return (directory, ageMs) => {
      const name = path.basename(directory);
      let history: DatabaseSnapshotHistory | undefined;
      try {
        // The staging suffix carries a random UUID and no LIKE escape character.
        const mentions = findUpdateRunsMentioning(name.slice(name.indexOf(STAGING_MARKER)), {
          env,
        });
        history = mentions && {
          capture: mentions.find((run) => isCaptureReceipt(run, name)),
          latestSuccess,
        };
      } catch {
        history = undefined;
      }
      return decideDatabaseSnapshot(
        directory,
        ageMs,
        history,
        existsSync(path.join(directory, stateDatabase)),
      );
    };
  } catch (error) {
    const reason = `update history could not be read: ${formatErrorMessage(error)}`;
    return () => ({ keep: reason });
  }
}
