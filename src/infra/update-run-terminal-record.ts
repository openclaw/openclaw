import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { UpdateRunLedgerOptions as LedgerOptions } from "./update-run-codec.js";
import { readUpdateRunRecord as readRun } from "./update-run-read.kernel.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { readRecoveries } from "./update-run-recovery-store.js";
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
      // Decode all retained evidence. Unknown or malformed recovery is never an
      // empty namespace, and any retained record keeps its existing finalizer.
      if (readRecoveries(db).length > 0) {
        return undefined;
      }
      const record = readRun(db, runId);
      assertCurrent();
      return record?.status === "succeeded" && record.phase === "finished" ? record : undefined;
    },
    options,
    {
      schemaSql: schema,
      operationLabel: "update.run",
      assertCurrent: () => options.assertWriteAdmission?.(runId, options),
    },
  );
}
