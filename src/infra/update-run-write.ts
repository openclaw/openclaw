import type { DatabaseSync } from "node:sqlite";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import {
  decodeRun,
  encodeRun,
  isRetainedStep,
  type UpdateRunLedgerOptions,
} from "./update-run-codec.js";
import { readUpdateRunRecord } from "./update-run-reader.js";
import type { UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";

const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS update_runs (");
const schemaEndMarker = "ON update_runs(status, created_at_ms DESC, run_id);";
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(schemaEndMarker, schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Update run schema markers are missing");
}
export const updateRunLedgerSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(
  schemaStart,
  schemaEnd + schemaEndMarker.length,
);

export function upsertStep(record: UpdateRunRecord, step: UpdateRunStep): void {
  const index = record.steps.findIndex((existing) => existing.step === step.step);
  if (index >= 0) {
    record.steps[index] = { ...record.steps[index], ...step };
  } else {
    record.steps.push(step);
  }
  while (record.steps.length > 128) {
    const disposable = record.steps.findIndex((entry) => !isRetainedStep(entry));
    if (disposable < 0) {
      throw new Error("Update run retained steps exceed the step limit");
    }
    record.steps.splice(disposable, 1);
  }
}

export function persistRun(
  db: DatabaseSync,
  record: UpdateRunRecord,
  options: UpdateRunLedgerOptions,
): UpdateRunRecord {
  record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
  const row = encodeRun(record, options);
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
      .updateTable("update_runs")
      .set(row)
      .where("run_id", "=", record.runId),
  );
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
          upsertStep(record, { ...failure, status: "failed" });
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
