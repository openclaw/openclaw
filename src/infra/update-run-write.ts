import type { DatabaseSync } from "node:sqlite";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import {
  mergeUpdateRunRecoveryCaptureState,
  type UpdateRecoveryCaptureState,
} from "./update-recovery-backup-contract.js";
import { decodeRun, encodeRun, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import { updateRunLedgerSchema } from "./update-run-ledger-schema.js";
import { readUpdateRunRecord } from "./update-run-reader.js";
import {
  upsertUpdateRunStep,
  type UpdateRunRecord,
  type UpdateRunStep,
} from "./update-run-record.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";

export function persistRun(
  db: DatabaseSync,
  record: UpdateRunRecord,
  options: UpdateRunLedgerOptions,
): UpdateRunRecord {
  record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
  const row = encodeRun(record, options);
  options.assertCurrent?.();
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
      .updateTable("update_runs")
      .set(row)
      .where("run_id", "=", record.runId),
  );
  options.assertCurrent?.();
  return decodeRun(row);
}

export function mutateRunInTransaction(
  db: DatabaseSync,
  runId: string,
  update: (record: UpdateRunRecord) => void,
  options: UpdateRunLedgerOptions,
  captureBefore?: (record: UpdateRunRecord) => void,
): UpdateRunRecord {
  const record = readUpdateRunRecord(db, runId);
  if (!record) {
    throw new Error(`Unknown update run: ${runId}`);
  }
  const before = JSON.stringify(record);
  captureBefore?.(structuredClone(record));
  update(record);
  return before === JSON.stringify(record) ? record : persistRun(db, record, options);
}

export function mutateRun(
  runId: string,
  update: (record: UpdateRunRecord) => void,
  options: UpdateRunLedgerOptions,
  captureBefore?: Parameters<typeof mutateRunInTransaction>[4],
): UpdateRunRecord {
  // An existing run can belong to a restored older runtime. History updates
  // must never reopen through bootstrap/migration merely to report its outcome.
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => mutateRunInTransaction(db, runId, update, options, captureBefore),
    options,
    {
      schemaSql: updateRunLedgerSchema,
      operationLabel: "update.run",
      busyTimeoutMs: options.busyTimeoutMs,
    },
  );
}

type RecoveryDiagnostics = Pick<UpdateRunRecord["verification"], "recovery" | "rollbackOutcome">;
type UpdateRunDiagnostics = RecoveryDiagnostics & {
  failure?: Pick<UpdateRunStep, "step" | "detail" | "failureFacts">;
};

/** Diagnostic capture cannot interrupt lifecycle work or replace its original outcome. */
export function recordUpdateRunDiagnostics(
  runId: string,
  diagnostics:
    | UpdateRunDiagnostics
    | ((recorded: Readonly<RecoveryDiagnostics>) => UpdateRunDiagnostics),
  warn: (message: string) => void,
  options: UpdateRunLedgerOptions = {},
): void {
  try {
    if (
      typeof diagnostics !== "function" &&
      !(diagnostics.failure || diagnostics.recovery || diagnostics.rollbackOutcome)
    ) {
      return;
    }
    mutateRun(
      runId,
      (record) => {
        const { failure, recovery, rollbackOutcome } =
          typeof diagnostics === "function" ? diagnostics(record.verification) : diagnostics;
        if (failure && record.status === "running") {
          upsertUpdateRunStep(record, { ...failure, status: "failed" });
        }
        if (recovery || rollbackOutcome) {
          recordUpdateRunVerificationRecord(record, {
            ...(recovery ? { recovery } : {}),
            ...(rollbackOutcome ? { rollbackOutcome } : {}),
          });
        }
      },
      options,
    );
  } catch (error) {
    const fact = createUpdateErrorFact("requested", error, options.env);
    warn(
      `Update diagnostics could not be recorded (${fact.code}): ${fact.message ?? "no error message"}`,
    );
  }
}

/** Exact recovery receipts share the existing run owner, outside diagnostic eviction. */
export function recordUpdateRunRecoveryCapture(
  runId: string,
  patch: Pick<UpdateRecoveryCaptureState, "manifestSha256"> & Partial<UpdateRecoveryCaptureState>,
  assertCurrent: () => void,
  options: UpdateRunLedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      assertCurrent();
      record.origin.updateRecoveryCapture = mergeUpdateRunRecoveryCaptureState(record, patch);
    },
    options,
  );
}
