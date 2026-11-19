/** Release rules for backups an update run recorded as its own; the run outcome decides. */
import { canonicalMigrationFilePath } from "../infra/session-sqlite-migration-manifest.js";
import { getUpdateRun } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { loadUpdateRecovery } from "../infra/update-run-recovery.js";
import {
  isVerifiedSuccessfulUpdate,
  readCompletedUpdateHistory,
} from "./update-capture-cleanup.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";

type History = NonNullable<ReturnType<typeof readCompletedUpdateHistory>>;
type Classification = Pick<RecoveryCleanupArtifact, "outcome" | "reason">;

/** Reasons for files the updater cannot prove it created; never deleted automatically. */
export const NOT_PROVABLY_UPDATER_OWNED_REASONS: ReadonlySet<string> = new Set([
  "unmanifested-recovery-original",
  "update-run-record-missing",
  "unreceipted-displaced-database",
]);

export type UpdateRunArtifactOwnership = {
  classify(runId: string, database: string): Classification;
};

/** One updater backup of one database that is still exactly what its record describes. */
export type IntactUpdateBackup = { runId: string; database: string };

/**
 * Owner-approved policy: a verified successful update releases its own backups and every
 * backup of a run that finished before it started. Without one, backups are released per
 * database, never per run.
 *
 * Invariant: for every database that had an intact updater backup with no verified
 * successful update after it, at least one intact backup of that database remains. An
 * older backup of database X is released only by a verified update after it, or by an
 * intact backup of the same X from a run that started after it finished. A run with a
 * damaged or partial set supersedes nothing for the databases it does not intactly cover.
 */
export function createUpdateRunArtifactOwnership(
  history: History | undefined,
  intactBackups: readonly IntactUpdateBackup[],
  env: NodeJS.ProcessEnv,
): UpdateRunArtifactOwnership {
  const runs = new Map<string, UpdateRunRecord | undefined>(
    (history?.runs ?? []).map((run) => [run.runId, run]),
  );
  const lookup = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, getUpdateRun(runId, { env }));
    }
    return runs.get(runId);
  };
  const pending = (run: UpdateRunRecord) => {
    const recovery = loadUpdateRecovery(run.runId, { env });
    return recovery !== undefined && isUpdateRecoveryPending(recovery);
  };
  // Updates run one at a time, so a later run started only after this one finished. Run
  // order, not file times, decides; equal start times never supersede each other. The run
  // being finalized is also guarded by its caller against a clock that moved backward.
  const supersededBy = (run: UpdateRunRecord, laterStartedAt: number) =>
    run.finishedAtMs !== null &&
    laterStartedAt > run.createdAtMs &&
    laterStartedAt >= run.finishedAtMs;
  const verifiedAfter = history?.latestVerifiedSuccessStartedAt ?? 0;
  // Start time of the newest run holding an intact backup of each database.
  const newestIntact = new Map<string, number>();
  for (const backup of intactBackups) {
    const run = lookup(backup.runId);
    if (run) {
      const key = canonicalMigrationFilePath(backup.database);
      newestIntact.set(key, Math.max(newestIntact.get(key) ?? 0, run.createdAtMs));
    }
  }
  return {
    classify(runId, database) {
      if (!history) {
        return { outcome: "protected", reason: "unreadable-update-history" };
      }
      const run = lookup(runId);
      if (!run) {
        return { outcome: "protected", reason: "update-run-record-missing" };
      }
      if (run.status === "running" || run.finishedAtMs === null) {
        return { outcome: "protected", reason: "unfinished-update-run" };
      }
      if (pending(run)) {
        return { outcome: "protected", reason: "pending-update-recovery" };
      }
      if (isVerifiedSuccessfulUpdate(run)) {
        return { outcome: "candidate", reason: "verified-update-backup" };
      }
      if (supersededBy(run, verifiedAfter)) {
        return { outcome: "candidate", reason: "superseded-by-verified-update" };
      }
      if (!supersededBy(run, newestIntact.get(canonicalMigrationFilePath(database)) ?? 0)) {
        return { outcome: "protected", reason: "newest-unverified-update-backup" };
      }
      if (history.hasPendingRecovery || history.hasUnfinishedRun) {
        return { outcome: "protected", reason: "awaiting-settled-update-history" };
      }
      return { outcome: "candidate", reason: "superseded-by-newer-update-backup" };
    },
  };
}
