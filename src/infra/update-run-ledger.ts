import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  UPDATE_RUN_DRIVER_LIMIT,
  UPDATE_RUN_PHASES,
} from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { formatErrorMessage } from "./errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import {
  inspectUpdateRepairDriverAdmission,
  isStaleIdentitylessUpdateRun,
  recordedUpdateRunDrivers,
} from "./update-run-activity.js";
import { runUpdateRunAdmission } from "./update-run-admission.js";
import { encodeRun, type UpdateRunLedgerOptions as LedgerOptions } from "./update-run-codec.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
  type UpdateRunDriver,
} from "./update-run-driver.js";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import { decodeRun, readUpdateRunRecord as readRun } from "./update-run-read.kernel.js";
import {
  inspectUpdateRunReconciliation,
  readUpdateRunReconciliationCandidates,
  type UpdateRunReconciliationCandidate,
  type UpdateRunReconciliationInput,
} from "./update-run-reader.js";
import {
  finishUpdateRunRecord,
  isAbandonedUpdateRun,
  isUnacknowledgedPackageOwnerRefusal,
  type UpdateRunRecord,
  type UpdateRunPhase,
  type UpdateRunStep,
} from "./update-run-record.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { hasStoredUpdateRecovery, readRecoveries } from "./update-run-recovery-store.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";
import {
  mutateRun,
  mutateRunInTransaction,
  persistRun,
  updateRunLedgerSchema as schema,
  upsertStep,
} from "./update-run-write.js";

export {
  findActiveUpdateRun,
  getLatestUpdateFetchFailure,
  getUpdateRun,
  getUpdateRunAsync,
  getUpdateRunStatusAsync,
  listUpdateRuns,
  listUpdateRunsAsync,
} from "./update-run-reader.js";

export { finishUpdateRun, recordUpdateRunDiagnostics } from "./update-run-write.js";

type LedgerDatabase = Pick<DB, "update_runs">;
type RunPatch = Partial<
  Pick<UpdateRunRecord, "origin" | "target" | "before" | "after" | "trigger">
>;

export function createUpdateRun(
  input: RunPatch & {
    runId?: string;
    trigger: UpdateRunRecord["trigger"];
    supersedeStaleIdentityless?: boolean;
    /** Preview history must not repair canonical task data. */
    preview?: boolean;
  },
  options: LedgerOptions = {},
): UpdateRunRecord {
  const now = Date.now();
  const row = encodeRun(
    {
      runId: input.runId ?? randomUUID(),
      createdAtMs: now,
      updatedAtMs: now,
      trigger: input.trigger,
      phase: "requested",
      status: "running",
      reason: null,
      origin: input.origin ?? {},
      target: input.target ?? {},
      before: input.before ?? {},
      after: {},
      steps: [{ step: "requested", status: "in_progress", startedAtMs: now }],
      verification: {},
      repair: [],
      confirmedAtMs: null,
      finishedAtMs: null,
      downtimeMs: null,
    },
    options,
  );
  return runUpdateRunAdmission(
    (db, recoveryChanges) => {
      const recordRecovery = (record: UpdateRunRecord) => {
        if (recoveryChanges.length > 0) {
          upsertStep(record, {
            step: "task-delivery-recovery",
            status: "completed",
            startedAtMs: now,
            endedAtMs: Date.now(),
            detail: recoveryChanges.join("\n"),
          });
        }
        return record;
      };
      const existing = readRun(db, row.run_id);
      if (existing) {
        return recoveryChanges.length > 0
          ? persistRun(db, recordRecovery(existing), options)
          : existing;
      }
      // Only an explicit new CLI invocation may supersede the single legacy run.
      // Selection, activity recheck, terminalization, and admission share this transaction.
      if (input.supersedeStaleIdentityless && !input.runId && input.trigger === "cli") {
        const active = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<LedgerDatabase>(db)
            .selectFrom("update_runs")
            .selectAll()
            .where("status", "=", "running")
            .limit(2),
        ).rows;
        const previous = active.length === 1 && active[0] ? decodeRun(active[0]) : undefined;
        if (
          previous &&
          !hasStoredUpdateRecovery(db, previous.runId) &&
          isStaleIdentitylessUpdateRun(previous)
        ) {
          upsertStep(previous, {
            step: "reconcile:superseded",
            status: "failed",
            endedAtMs: now,
            detail: "operator-started-update-supersedes-inactive-identityless-run",
          });
          finishUpdateRunRecord(previous, { status: "failed", reason: "superseded" });
          persistRun(db, previous, options);
        }
      }
      const admittedRow = encodeRun(recordRecovery(decodeRun(row)), options);
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<LedgerDatabase>(db).insertInto("update_runs").values(admittedRow),
      );
      return decodeRun(admittedRow);
    },
    options,
    {
      schemaSql: schema,
      busyTimeoutMs: options.busyTimeoutMs,
      recoverTaskDeliveryOrphans: !input.preview,
    },
  );
}

/** Adoption is explicit: reading or reserving an existing run does not make this process its driver. */
export function adoptUpdateRun(runId: string, options: LedgerOptions = {}): UpdateRunRecord {
  const driver = readUpdateRunDriver();
  let identityUnavailable = false;
  const adopted = mutateRun(
    runId,
    (record) => {
      if (record.status !== "running") {
        throw new Error(`Update run ${runId} is already ${record.status}; it cannot be adopted.`);
      }
      if (!driver) {
        if (!record.steps.some((step) => step.step === "driver:identity-unavailable")) {
          // Retain known parents, but their death cannot prove this adopter exited.
          upsertStep(record, {
            step: "driver:identity-unavailable",
            status: "completed",
            endedAtMs: Date.now(),
          });
          identityUnavailable = true;
        }
        return;
      }
      const previousDrivers: UpdateRunDriver[] = [];
      for (const previous of recordedUpdateRunDrivers(record)) {
        if (
          !sameUpdateRunDriver(previous, driver) &&
          !previousDrivers.some((retained) => sameUpdateRunDriver(retained, previous)) &&
          inspectUpdateRunDriver(previous) !== "dead"
        ) {
          previousDrivers.push(previous);
        }
      }
      if (previousDrivers.length >= UPDATE_RUN_DRIVER_LIMIT) {
        throw new Error(
          `Update run ${runId} has too many live or unobservable drivers; adoption refused.`,
        );
      }
      const retained = record.origin.previousDrivers ?? [];
      if (
        record.origin.driver &&
        sameUpdateRunDriver(record.origin.driver, driver) &&
        record.steps.some((step) => step.step === "driver:adopted") &&
        retained.length === previousDrivers.length &&
        retained.every((previous, index) => {
          const next = previousDrivers[index];
          return next !== undefined && sameUpdateRunDriver(previous, next);
        })
      ) {
        return;
      }
      record.origin.driver = driver;
      record.origin.previousDrivers = previousDrivers.length ? previousDrivers : undefined;
      upsertStep(record, {
        step: "driver:adopted",
        status: "completed",
        endedAtMs: Date.now(),
      });
    },
    options,
  );
  if (identityUnavailable) {
    console.warn(
      "[update] Driver identity recording is unavailable. The update will continue; this run requires explicit recovery if it stops reporting progress.",
    );
  }
  return adopted;
}

/** Retained orchestrators can renew their children; pruned identities cannot. */
export function heartbeatUpdateRun(
  runId: string,
  driver: UpdateRunDriver | undefined,
  options: LedgerOptions = {},
): void {
  if (!driver) {
    return;
  }
  mutateRun(
    runId,
    (record) => {
      if (
        record.status === "running" &&
        recordedUpdateRunDrivers(record).some((current) => sameUpdateRunDriver(current, driver))
      ) {
        record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
      }
    },
    options,
  );
}

/** Record successful repair without changing the failed outcome; report only new acknowledgment. */
export function acknowledgeAbandonedUpdateRun(runId: string, options: LedgerOptions = {}): boolean {
  let acknowledged = false;
  mutateRun(
    runId,
    (record) => {
      if (
        isAbandonedUpdateRun(record) &&
        !record.steps.some((step) => step.step === "reconcile:acknowledged")
      ) {
        upsertStep(record, {
          step: "reconcile:acknowledged",
          status: "completed",
          endedAtMs: Date.now(),
        });
        acknowledged = true;
      }
    },
    options,
  );
  return acknowledged;
}

function canReconcileCandidates(
  candidates: UpdateRunReconciliationCandidate[],
  input: UpdateRunReconciliationInput,
): boolean {
  return (
    candidates.some(
      ({ rule }) => rule && (!input.legacyOnly || rule === LEGACY_UPDATE_RUN_EXPIRED_REASON),
    ) &&
    !(input.explicit && candidates.some(({ record, rule }) => record.status === "running" && !rule))
  );
}

/** Prepare eligibility without write access, then revalidate under the writer's transaction. */
export function reconcileAbandonedUpdateRuns(
  input: UpdateRunReconciliationInput = {},
  options: LedgerOptions = {},
): UpdateRunRecord[] {
  if (input.runIds?.length === 0) {
    return [];
  }
  const candidates =
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readUpdateRunReconciliationCandidates(db, input),
      options,
    ) ?? [];
  return reconcileCandidates(candidates, input, options).reconciled;
}

export async function reconcileAbandonedUpdateRunsAsync(
  input: UpdateRunReconciliationInput = {},
  options: LedgerOptions = {},
): Promise<UpdateRunRecord[]> {
  if (input.runIds?.length === 0) {
    return [];
  }
  const candidates =
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      ({ db }) => readUpdateRunReconciliationCandidates(db, input),
      options,
    )) ?? [];
  return reconcileCandidates(candidates, input, options).reconciled;
}

/** History remains readable when best-effort reconciliation cannot obtain write access. */
export async function getUpdateRunWithReconciliationAsync(
  runId: string,
  options: LedgerOptions = {},
): Promise<{ run: UpdateRunRecord | undefined; reconciliationError?: string }> {
  const candidate = await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
    ({ db }) => {
      const run = tableExists(db, "update_runs") ? readRun(db, runId) : undefined;
      return run ? inspectUpdateRunReconciliation(db, run, {}) : undefined;
    },
    options,
  );
  if (!candidate) {
    return { run: undefined };
  }
  try {
    const { current } = reconcileCandidates([candidate], {}, options);
    return { run: current[0] };
  } catch (error) {
    return { run: candidate.record, reconciliationError: formatErrorMessage(error) };
  }
}

function reconcileCandidates(
  candidates: UpdateRunReconciliationCandidate[],
  input: UpdateRunReconciliationInput,
  options: LedgerOptions,
): { current: UpdateRunRecord[]; reconciled: UpdateRunRecord[] } {
  if (!canReconcileCandidates(candidates, input)) {
    return { current: candidates.map(({ record }) => record), reconciled: [] };
  }
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const selected = candidates.flatMap(({ record }) => {
        const current = readRun(db, record.runId);
        return current ? [inspectUpdateRunReconciliation(db, current, input)] : [];
      });
      const current = selected.map(({ record }) => record);
      if (
        !canReconcileCandidates(selected, input) ||
        (input.requireAllActive &&
          executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<LedgerDatabase>(db)
              .selectFrom("update_runs")
              .select("run_id")
              .where("status", "=", "running")
              .where(
                "run_id",
                "not in",
                candidates.map(({ record }) => record.runId),
              )
              .limit(1),
          ))
      ) {
        return { current, reconciled: [] };
      }
      const reconciled: UpdateRunRecord[] = [];
      return {
        current: selected.map(({ record, rule }) => {
          if (!rule || (input.legacyOnly && rule !== LEGACY_UPDATE_RUN_EXPIRED_REASON)) {
            return record;
          }
          upsertStep(record, {
            step: "reconcile:abandoned",
            status: "failed",
            endedAtMs: Date.now(),
            detail: rule,
          });
          finishUpdateRunRecord(record, {
            status: "failed",
            reason: rule === LEGACY_UPDATE_RUN_EXPIRED_REASON ? rule : "abandoned",
          });
          const saved = persistRun(db, record, options);
          reconciled.push(saved);
          return saved;
        }),
        reconciled,
      };
    },
    options,
    { schemaSql: schema, operationLabel: "update.run", busyTimeoutMs: options.busyTimeoutMs },
  );
}

export function recordUpdateRunPhase(
  runId: string,
  phase: UpdateRunPhase,
  patch: RunPatch & { step?: UpdateRunStep } = {},
  options: LedgerOptions = {},
  captureBefore?: Parameters<typeof mutateRun>[3],
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
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
    },
    options,
    captureBefore,
  );
}

export function recordUpdateRunStep(
  runId: string,
  { reason, ...step }: UpdateRunStep & { reason?: string },
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      if (record.status === "running") {
        upsertStep(record, step);
        if (reason !== undefined) {
          record.reason = reason;
        }
      }
    },
    options,
  );
}

export function recordUpdateRunRepairContinuation(
  runId: string,
  inheritedRunId: string | undefined,
  options: LedgerOptions = {},
): void {
  mutateRun(
    runId,
    (record) => {
      const admission = inspectUpdateRepairDriverAdmission([record], inheritedRunId);
      if (admission.kind === "conflict") {
        throw new Error(admission.message);
      }
      const step =
        admission.kind === "continuation"
          ? "finalize:repair-continuation"
          : "finalize:repair-takeover";
      if (record.steps.some((entry) => entry.step === step)) {
        return;
      }
      upsertStep(record, {
        step,
        status: "completed",
        endedAtMs: Date.now(),
        detail:
          admission.kind === "continuation"
            ? `Repair continued within the owning update by PID ${process.pid}.`
            : `Repair took over Gateway activation by PID ${process.pid} under abandonment admission.`,
      });
    },
    options,
  );
}

/** A terminal process diagnostic adds evidence without reopening the recorded outcome. */
export function recordUpdateRunDiagnostic(
  runId: string,
  detail: string,
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      upsertStep(record, {
        step: "finalize:exit",
        status: "completed",
        endedAtMs: Date.now(),
        detail,
      });
    },
    options,
  );
}

/** Correct the shipped refusal classification only after its install target was satisfied. */
export function reconcilePackageOwnerRefusal(
  expected: UpdateRunRecord,
  options: LedgerOptions = {},
): boolean {
  if (!isUnacknowledgedPackageOwnerRefusal(expected)) {
    return false;
  }
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = getNodeSqliteKysely<LedgerDatabase>(db).selectFrom("update_runs");
      const latest = executeSqliteQueryTakeFirstSync(
        db,
        query.selectAll().orderBy("created_at_ms", "desc").orderBy("run_id", "desc").limit(1),
      );
      if (
        !latest ||
        !isDeepStrictEqual(decodeRun(latest), expected) ||
        executeSqliteQueryTakeFirstSync(
          db,
          query.select("run_id").where("status", "=", "running").limit(1),
        ) ||
        readRecoveries(db).some(
          (entry) => entry.runId === expected.runId || isUpdateRecoveryPending(entry),
        )
      ) {
        return false;
      }
      mutateRunInTransaction(
        db,
        expected.runId,
        (record) => {
          record.status = "skipped";
          record.reason = "unmanaged-package-install";
          for (const step of record.steps) {
            if (step.step === "requested") {
              step.status = "skipped";
            }
          }
          upsertStep(record, {
            step: "reconcile:acknowledged",
            status: "completed",
            endedAtMs: Date.now(),
          });
        },
        options,
      );
      return true;
    },
    options,
    { schemaSql: schema, operationLabel: "update.run", busyTimeoutMs: options.busyTimeoutMs },
  );
}

/** Close only this local preview, excluding recovery in the same stable-schema transaction. */
export function finishInterruptedUpdatePreview(
  expected: UpdateRunRecord,
  options: LedgerOptions,
): void {
  if (expected.status !== "running" || expected.phase !== "requested") {
    throw new Error("Preview interruption requires an active admission");
  }
  runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      if (
        readRecoveries(db).some(
          (entry) => entry.runId === expected.runId || isUpdateRecoveryPending(entry),
        )
      ) {
        return;
      }
      mutateRunInTransaction(
        db,
        expected.runId,
        (record) => {
          if (isDeepStrictEqual(record, expected)) {
            finishUpdateRunRecord(record, { status: "skipped", reason: "interrupted" });
          }
        },
        options,
      );
    },
    options,
    { schemaSql: schema, operationLabel: "update.preview.interrupted" },
  );
}

/** Caller holds fresh local admission and a live executor; retained recovery stays refused. */
export function finishInterruptedUpdateBeforeActivation(
  expected: UpdateRunRecord,
  assertCurrent: () => void,
  options: LedgerOptions,
): void {
  if (
    expected.status !== "running" ||
    !["requested", "staging", "validating"].includes(expected.phase)
  ) {
    throw new Error("Update interruption requires its live pre-activation transaction");
  }
  const recoveryTable = "config_machine_state";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${recoveryTable} (`);
  const marker = ") STRICT;";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
  if (start < 0 || end < 0) {
    throw new Error("Interrupted update schema is unavailable.");
  }
  const recoverySchema = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length);
  assertCurrent();
  runExistingOpenClawStateWriteTransaction(
    ({ db, path: pathname }) => {
      assertCurrent();
      // Older targets can omit recovery storage and predate STRICT metadata.
      // The existing writer validates metadata ownership/version; present recovery
      // storage must still match its canonical shape before excluding recovery.
      const recoveryObject = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<{ "main.sqlite_schema": { name: string } }>(db)
          .selectFrom("main.sqlite_schema")
          .select("name")
          .where("name", "=", recoveryTable),
      );
      if (recoveryObject) {
        assertSqliteSchemaContains(db, pathname, recoverySchema);
      }
      if (
        !readRecoveries(db).some(
          (entry) => entry.runId === expected.runId || isUpdateRecoveryPending(entry),
        )
      ) {
        mutateRunInTransaction(
          db,
          expected.runId,
          (record) => {
            if (isDeepStrictEqual(record, expected)) {
              finishUpdateRunRecord(record, { status: "failed", reason: "interrupted" });
            }
          },
          options,
        );
      }
      assertCurrent();
    },
    options,
    { schemaSql: schema, operationLabel: "update.interrupted" },
  );
}

export function recordUpdateRunVerification(
  runId: string,
  verification: UpdateRunRecord["verification"],
  options: LedgerOptions & { onlyIfRunning?: true } = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => recordUpdateRunVerificationRecord(record, verification, options),
    options,
  );
}

export function recordUpdateRunRepairAttempt(
  runId: string,
  attempt: UpdateRunRecord["repair"][number],
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      if (record.status !== "running") {
        return;
      }
      record.repair = [
        ...record.repair.filter((entry) => entry.attempt !== attempt.attempt),
        attempt,
      ].slice(-16);
    },
    options,
  );
}
