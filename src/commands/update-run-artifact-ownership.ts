/** Release rules for backups an update run recorded as its own; the run outcome decides. */
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
  classify(runId: string): Classification;
};

/**
 * Owner-approved policy: a verified successful update releases its own backups and every
 * backup of an earlier finished run. Without one, the newest run's set is kept and older
 * sets go only while no recovery is pending and no run is unfinished.
 */
export function createUpdateRunArtifactOwnership(
  history: History | undefined,
  ownerRunIds: Iterable<string>,
  env: NodeJS.ProcessEnv,
): UpdateRunArtifactOwnership {
  const runs = new Map<string, UpdateRunRecord | undefined>();
  const lookup = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(
        runId,
        history?.runs.find((run) => run.runId === runId) ?? getUpdateRun(runId, { env }),
      );
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
  const unverified = [...new Set(ownerRunIds)]
    .map(lookup)
    .filter(
      (run): run is UpdateRunRecord =>
        run !== undefined &&
        run.finishedAtMs !== null &&
        !isVerifiedSuccessfulUpdate(run) &&
        !supersededBy(run, verifiedAfter),
    )
    .toSorted((a, b) => b.createdAtMs - a.createdAtMs);
  const newest = unverified[0];
  return {
    classify(runId) {
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
      if (!newest || !supersededBy(run, newest.createdAtMs)) {
        return { outcome: "protected", reason: "newest-unverified-update-backup" };
      }
      if (history.hasPendingRecovery || history.hasUnfinishedRun) {
        return { outcome: "protected", reason: "awaiting-settled-update-history" };
      }
      return { outcome: "candidate", reason: "superseded-by-newer-update-backup" };
    },
  };
}
