import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { UpdateRunLedgerOptions as LedgerOptions } from "./update-run-codec.js";
import { readUpdateRunRecord as readRun } from "./update-run-read.kernel.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { inspectRecoveryRows } from "./update-run-recovery-store.js";
import { updateRunLedgerSchema as schema } from "./update-run-write.js";

/** Retain a completed outcome while its updater still owns the existing state.
 * Publication consumes this fact after release; it never grants recovery authority. */
export function captureCompletedUpdateRun(
  runId: string,
  assertCurrent: () => void,
  options: LedgerOptions,
): UpdateRunRecord | undefined {
  assertCurrent();
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
      // A matching operation keeps its finalizer; unfinished recovery still
      // blocks. Unrelated completed history is not authority for this run.
      if (
        inspectRecoveryRows(db).some(
          ({ record }) => record.runId === runId || isUpdateRecoveryPending(record),
        )
      ) {
        return undefined;
      }
      const record = readRun(db, runId);
      assertCurrent();
      return record?.status === "succeeded" && record.phase === "finished" ? record : undefined;
    },
    options,
    { schemaSql: schema, operationLabel: "update.run" },
  );
}
