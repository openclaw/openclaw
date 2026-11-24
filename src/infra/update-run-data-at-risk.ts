import type { UpdateRunRecord } from "./update-run-record.js";

/**
 * A recorded data-at-risk mark is a claim an update made when a step failed, often from a
 * catch-all. The mark stays on its run; a later run's receipt step records that
 * verification found the state consistent. Readers treat "marked, later verified" as
 * resolved. `update-data-at-risk.ts` owns the verification itself.
 */

const VERIFIED_STEP_PREFIX = "finalize:data-at-risk-verified:";

/** The named risk an update recorded; published updaters persist it the same way. */
export function readRecordedDataAtRisk(run: UpdateRunRecord | undefined): string | undefined {
  const recovery = run?.verification.recovery;
  return recovery?.serviceRestartSafe === false ? recovery.dataAtRisk : undefined;
}

/** Receipt step a later run records once verification found the marked run's state consistent. */
export function dataAtRiskVerifiedStep(markedRunId: string): string {
  return `${VERIFIED_STEP_PREFIX}${markedRunId}`;
}

function hasVerifiedDataAtRisk(
  runs: readonly (UpdateRunRecord | undefined)[],
  markedRunId: string,
): boolean {
  const step = dataAtRiskVerifiedStep(markedRunId);
  return runs.some((run) =>
    run?.steps.some((entry) => entry.step === step && entry.status === "completed"),
  );
}

/** The mark that still needs verification; undefined when none was recorded or it was verified. */
export function findUnverifiedDataAtRisk(
  marked: UpdateRunRecord | undefined,
  history: readonly (UpdateRunRecord | undefined)[],
): string | undefined {
  const mark = readRecordedDataAtRisk(marked);
  return mark && marked && !hasVerifiedDataAtRisk(history, marked.runId) ? mark : undefined;
}

export type RecordedDataAtRisk = {
  runId: string;
  mark: string;
  /**
   * The run's database rollback completed. The restore owner keeps the displaced
   * `<db>.migrated-<run>` files for manual recovery, so they are not a partial restore.
   */
  databaseRestored?: true;
};

/** A mark with the run facts its verification needs. */
export function describeRecordedDataAtRisk(run: UpdateRunRecord, mark: string): RecordedDataAtRisk {
  // Compaction can evict the ordinary step but keeps the rollback's diagnostic receipt,
  // which only a completed restore writes.
  const restored = run.steps.some(
    (entry) =>
      (entry.step === "database rollback" && entry.status === "completed") ||
      (entry.step === "diagnostic:database rollback" &&
        entry.detail?.startsWith("Restored pre-migration databases") === true),
  );
  return { runId: run.runId, mark, ...(restored ? { databaseRestored: true as const } : {}) };
}

/** Newest-first history: every recorded mark that no run has verified yet, newest first. */
export function listUnverifiedDataAtRisk(
  history: readonly UpdateRunRecord[],
): RecordedDataAtRisk[] {
  return history.flatMap((run) => {
    const mark = findUnverifiedDataAtRisk(run, history);
    return mark ? [describeRecordedDataAtRisk(run, mark)] : [];
  });
}
