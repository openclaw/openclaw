import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { UpdateRunLedgerOptions as LedgerOptions } from "./update-run-codec.js";
import {
  hasStoredUpdateRecovery,
  readUpdateRunRecord as readRun,
} from "./update-run-read.kernel.js";
import type { UpdateRunRecord } from "./update-run-record.js";
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
      // Only this operation's recovery retains its finalizer.
      if (hasStoredUpdateRecovery(db, runId)) {
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
