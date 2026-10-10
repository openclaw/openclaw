import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { UPDATE_RUN_DRIVER_LIMIT } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
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
import type { UpdateRunPatch as RunPatch } from "./update-run-mutation.types.js";
import {
  decodeRun,
  hasStoredUpdateRecovery,
  readUpdateRunRecord as readRun,
} from "./update-run-read.kernel.js";
import {
  finishUpdateRunRecord,
  isAbandonedUpdateRun,
  isUnacknowledgedPackageOwnerRefusal,
  type UpdateRunRecord,
  type UpdateRunPhase,
  type UpdateRunStep,
} from "./update-run-record.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { inspectRecoveryRows } from "./update-run-recovery-store.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";
import {
  applyUpdateRunPhase,
  applyUpdateRunStep,
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

export {
  getUpdateRunWithReconciliationAsync,
  reconcileAbandonedUpdateRunsAsync,
} from "./update-run-reconciliation.js";

export { finishUpdateRun, recordUpdateRunDiagnostics } from "./update-run-write.js";

type LedgerDatabase = Pick<DB, "update_runs">;
export function createUpdateRun(
  input: RunPatch & {
    runId?: string;
    trigger: UpdateRunRecord["trigger"];
    supersedeStaleIdentityless?: boolean;
    /** Preview history must not repair canonical task data. */
    preview?: boolean;
    /** Record an already completed repair without publishing a transient running row. */
    settlement?: { reason: string; detail: string };
  },
  options: LedgerOptions = {},
): UpdateRunRecord {
  const now = Date.now();
  const initial: UpdateRunRecord = {
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
  };
  if (input.settlement) {
    upsertStep(initial, {
      step: "reconcile:settle",
      status: "completed",
      endedAtMs: now,
      detail: input.settlement.detail,
    });
    finishUpdateRunRecord(initial, { status: "succeeded", reason: input.settlement.reason });
  }
  const row = encodeRun(initial, options);
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
    !input.preview,
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

export function recordUpdateRunPhase(
  runId: string,
  phase: UpdateRunPhase,
  patch: RunPatch & { step?: UpdateRunStep } = {},
  options: LedgerOptions = {},
  captureBefore?: Parameters<typeof mutateRun>[3],
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => applyUpdateRunPhase(record, phase, patch),
    options,
    captureBefore,
  );
}

export function recordUpdateRunStep(
  runId: string,
  step: UpdateRunStep & { reason?: string },
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(runId, (record) => applyUpdateRunStep(record, step), options);
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
  step = "finalize:exit",
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      upsertStep(record, { step, status: "completed", endedAtMs: Date.now(), detail });
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
        inspectRecoveryRows(db).some(
          ({ record }) => record.runId === expected.runId || isUpdateRecoveryPending(record),
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

function finishInterruptedRunInTransaction(
  db: DatabaseSync,
  expected: UpdateRunRecord,
  status: "skipped" | "failed",
  options: LedgerOptions,
): void {
  if (
    inspectRecoveryRows(db).some(
      ({ record }) => record.runId === expected.runId || isUpdateRecoveryPending(record),
    )
  ) {
    return;
  }
  mutateRunInTransaction(
    db,
    expected.runId,
    (record) => {
      if (isDeepStrictEqual(record, expected)) {
        finishUpdateRunRecord(record, { status, reason: "interrupted" });
      }
    },
    options,
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
    ({ db }) => finishInterruptedRunInTransaction(db, expected, "skipped", options),
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
  const recoverySchema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, recoveryTable, {
    endMarker: ") STRICT;",
    errorMessage: "Interrupted update schema is unavailable.",
  });
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
      finishInterruptedRunInTransaction(db, expected, "failed", options);
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
