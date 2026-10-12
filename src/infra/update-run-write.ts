import type { DatabaseSync } from "node:sqlite";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { completeUpdateFailureSummary } from "./update-failure-result.js";
import { encodeRun, isRetainedStep, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { UpdateRunPhasePatch } from "./update-run-mutation.types.js";
import { decodeRun, readUpdateRunRecord } from "./update-run-read.kernel.js";
import {
  finishUpdateRunRecord,
  type FinishUpdateRunInput,
  type UpdateRunDiagnostics,
  type UpdateRunPhase,
  type UpdateRunRecord,
  type UpdateRunStep,
} from "./update-run-record.js";
import { updateRunStepKey } from "./update-run-step-key.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";

export const updateRunLedgerSchema = extractSqliteTableSchema(
  OPENCLAW_STATE_SCHEMA_SQL,
  "update_runs",
  {
    endMarker: "ON update_runs(status, created_at_ms DESC, run_id);",
    errorMessage: "Update run schema markers are missing",
  },
);

export function upsertStep(record: UpdateRunRecord, input: UpdateRunStep): void {
  const step = { ...input, step: updateRunStepKey(input.step) };
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

export function applyUpdateRunPhase(
  record: UpdateRunRecord,
  phase: UpdateRunPhase,
  patch: UpdateRunPhasePatch,
): void {
  if (record.status !== "running") {
    return;
  }
  if (patch.origin) {
    record.origin = { ...record.origin, ...patch.origin };
  }
  if (patch.target) {
    record.target = { ...record.target, ...patch.target };
  }
  if (patch.before) {
    record.before = { ...record.before, ...patch.before };
  }
  if (patch.after) {
    record.after = { ...record.after, ...patch.after };
  }
  if (patch.trigger) {
    record.trigger = patch.trigger;
  }
  const repairsVerification = phase === "repairing" && record.phase === "verifying";
  const advances = UPDATE_RUN_PHASES.indexOf(phase) > UPDATE_RUN_PHASES.indexOf(record.phase);
  // Post-activation repair may only return to verification; stale staging
  // writers must not reopen activation while the live candidate is repaired.
  const resumesVerification =
    record.phase === "repairing" && record.steps.some((step) => step.step === "verifying");
  if (
    phase !== "finished" &&
    (repairsVerification || (advances && (!resumesVerification || phase === "verifying")))
  ) {
    const now = Date.now();
    upsertStep(record, { step: record.phase, status: "completed", endedAtMs: now });
    record.phase = phase;
    upsertStep(record, {
      step: phase,
      status: "in_progress",
      startedAtMs: now,
      endedAtMs: undefined,
    });
  }
  if (patch.step) {
    upsertStep(record, patch.step);
  }
}

export function applyUpdateRunStep(
  record: UpdateRunRecord,
  { reason, ...step }: UpdateRunStep & { reason?: string },
): void {
  if (record.status === "running") {
    upsertStep(record, step);
    if (reason !== undefined) {
      record.reason = reason;
    }
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

export const UPDATE_RUN_BOOKKEEPING_TIMEOUT_MS = 1_000;

// Recovery requirements are independent of diagnostic history's eviction priority.
const REQUIRED_UPDATE_RUN_STEPS = new Set<string>([
  ...UPDATE_RUN_PHASES,
  "candidate-admission",
  "global update",
  "global update (omit optional)",
  "candidate-doctor-lint",
  "previous generation restoration",
  "post-update verification",
  "task-delivery-recovery",
  "openclaw doctor",
  "package rollback",
  "config rollback",
  "git-runtime-rollback",
]);

/** Recovery reads these receipts as well as phases and terminal outcomes. */
export function isRequiredUpdateRunStep(step: UpdateRunStep & { reason?: string }): boolean {
  const key = updateRunStepKey(step.step);
  return (
    REQUIRED_UPDATE_RUN_STEPS.has(key) ||
    step.status === "failed" ||
    step.reason !== undefined ||
    step.termination === "signal" ||
    key.startsWith("finalize:") ||
    key.startsWith("driver:") ||
    key.startsWith("notice:") ||
    key.startsWith("reconcile:") ||
    key.startsWith("diagnostic:database ") ||
    key.startsWith("git-rollback-")
  );
}

type RecoveryDiagnostics = Pick<UpdateRunRecord["verification"], "recovery" | "rollbackOutcome">;
type UpdateRunDiagnosticsInput =
  | UpdateRunDiagnostics
  | ((recorded: Readonly<RecoveryDiagnostics>) => UpdateRunDiagnostics);

export function applyUpdateRunDiagnostics(
  record: UpdateRunRecord,
  diagnostics: UpdateRunDiagnosticsInput,
): void {
  const {
    failure,
    verification,
    steps,
    recovery: observedRecovery,
    rollbackOutcome: observedRollback,
  } = typeof diagnostics === "function" ? diagnostics(record.verification) : diagnostics;
  if (failure && record.status === "running") {
    upsertStep(record, { ...failure, status: "failed" });
  } else if (failure && record.status === "failed") {
    // A helper can finish before its parent observes the failure. Enrich only
    // the already-failed step; terminal outcomes and prior facts stay authoritative.
    const previous = record.steps.find((step) => step.step === updateRunStepKey(failure.step));
    if (previous?.status === "failed") {
      upsertStep(record, {
        ...previous,
        detail: previous.detail ?? failure.detail,
        exitCode: previous.exitCode ?? failure.exitCode,
        failureFacts: [
          ...new Map(
            [...(previous.failureFacts ?? []), ...(failure.failureFacts ?? [])].map((fact) => [
              JSON.stringify(fact),
              fact,
            ]),
          ).values(),
        ].slice(0, 5),
      });
    }
  }
  if (verification) {
    const { recovery, rollbackOutcome, booted, noticeDelivered, doctorHint } = record.verification;
    record.verification = { recovery, rollbackOutcome, booted, noticeDelivered, doctorHint };
    record.confirmedAtMs = null;
    for (const step of (steps ?? []).flatMap(updateRunStepsFromResultStep)) {
      upsertStep(record, step);
    }
  }
  const constraint = record.verification.recovery;
  const recovery =
    verification && constraint?.serviceRestartSafe === false ? constraint : observedRecovery;
  if (recovery || observedRollback || verification) {
    recordUpdateRunVerificationRecord(record, {
      ...verification,
      ...(verification ? record.verification : {}),
      ...(recovery ? { recovery } : {}),
      ...(observedRollback ? { rollbackOutcome: observedRollback } : {}),
    });
  }
}

/** Diagnostic capture cannot interrupt lifecycle work or replace its original outcome. */
export function recordUpdateRunDiagnostics(
  runId: string,
  diagnostics: UpdateRunDiagnosticsInput,
  warn: (message: string) => void,
  options: UpdateRunLedgerOptions = {},
): UpdateRunRecord | undefined {
  try {
    if (
      typeof diagnostics !== "function" &&
      !(
        diagnostics.failure ||
        diagnostics.recovery ||
        diagnostics.rollbackOutcome ||
        diagnostics.verification
      )
    ) {
      return undefined;
    }
    return mutateRun(runId, (record) => applyUpdateRunDiagnostics(record, diagnostics), options);
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    const fact = createUpdateErrorFact("requested", error, options.env);
    warn(
      `Update diagnostics could not be recorded (${fact.code}): ${fact.message ?? "no error message"}`,
    );
    return undefined;
  }
}

export function finishUpdateRun(
  runId: string,
  result: FinishUpdateRunInput,
  options: UpdateRunLedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(runId, (record) => applyFinishUpdateRun(record, result), options);
}

export function applyFinishUpdateRun(record: UpdateRunRecord, result: FinishUpdateRunInput): void {
  if (record.status === "running") {
    const diagnostics = result.diagnostics;
    if (diagnostics) {
      applyUpdateRunDiagnostics(record, diagnostics);
      if (!diagnostics.verification) {
        for (const step of (diagnostics.steps ?? []).flatMap(updateRunStepsFromResultStep)) {
          upsertStep(record, step);
        }
      }
    }
    record.before = { ...record.before, ...result.before };
    const failed =
      record.steps.find((step) => step.status === "failed" && step.failureFacts?.length) ??
      (result.status === "failed"
        ? record.steps.find((step) => step.step === record.phase)
        : undefined);
    finishUpdateRunRecord(record, result);
    if (result.status === "failed" || result.status === "rolled-back") {
      const summary = completeUpdateFailureSummary(record.reason, failed?.failureFacts);
      record.reason = summary.reason;
      if (failed) {
        failed.failureFacts = summary.failureFacts;
      } else {
        upsertStep(record, {
          step: "update",
          status: "failed",
          failureFacts: summary.failureFacts,
        });
      }
    }
  }
}
