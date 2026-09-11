import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  UPDATE_RUN_DRIVER_LIMIT,
  UPDATE_RUN_PHASES,
} from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { formatErrorMessage } from "./errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  mergeUpdateRecoveryCaptureState,
  type UpdateRecoveryCaptureState,
} from "./update-recovery-backup-contract.js";
import {
  isAbandonedUpdateRun,
  isStaleIdentitylessUpdateRun,
  recordedUpdateRunDrivers,
} from "./update-run-activity.js";
import {
  decodeRun,
  encodeRun,
  type UpdateRunLedgerOptions as LedgerOptions,
} from "./update-run-codec.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
  type UpdateRunDriver,
} from "./update-run-driver.js";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import {
  canReconcileCandidates,
  inspectUpdateRunReconciliation,
  readUpdateRunReconciliationCandidates,
  readUpdateRunRecord as readRun,
  type UpdateRunReconciliationCandidate,
  type UpdateRunReconciliationInput,
} from "./update-run-reader.js";
import {
  finishUpdateRunRecord,
  upsertUpdateRunStep,
  declareUnprotectedGatewayUpdateRecord,
  bindUnprotectedGatewayUpdateFinalizerRecord,
  type FinishUpdateRunResult,
  type UpdateRunRecord,
  type UpdateRunPhase,
  type UpdateRunStep,
} from "./update-run-record.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { hasStoredUpdateRecovery, readRecoveries } from "./update-run-recovery-store.js";

export {
  findActiveUpdateRun,
  getUpdateRun,
  getLatestUpdateFetchFailure,
  getUpdateRunAsync,
  listUpdateRuns,
  listUpdateRunsAsync,
} from "./update-run-reader.js";

type LedgerDatabase = Pick<DB, "update_runs">;
type RunPatch = Partial<
  Pick<UpdateRunRecord, "origin" | "target" | "before" | "after" | "trigger">
>;

const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS update_runs (");
const schemaEndMarker = "ON update_runs(status, created_at_ms DESC, run_id);";
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(schemaEndMarker, schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Update run schema markers are missing");
}
const schema = OPENCLAW_STATE_SCHEMA_SQL.slice(schemaStart, schemaEnd + schemaEndMarker.length);
const readyDatabases = new WeakSet<DatabaseSync>();

/** Canonical additive history table. */
export function ensureUpdateRunLedgerSchema(db: DatabaseSync): void {
  db.exec(schema); // sqlite-allow-raw -- Canonical lazy additive DDL bootstrap only.
}

function writeRun<T>(operation: (db: DatabaseSync) => T, options: OpenClawStateDatabaseOptions): T {
  if (options.database) {
    throw new Error("Update run admission requires its own writable connection");
  }
  // Admission precedes managed shutdown. An older serving Gateway must not
  // force diagnostic writes through this candidate's runtime migrations.
  // Once a file exists, failures remain failures; never retry via bootstrap.
  if (withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(() => true, options)) {
    return runExistingOpenClawStateWriteTransaction(({ db }) => operation(db), options, {
      schemaSql: schema,
      operationLabel: "update.run",
      initializeAdditiveSchema: true,
    });
  }
  let committedDatabase: DatabaseSync | undefined;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Feature-local, idempotent DDL shares the write transaction; a failed write also rolls back first use.
      if (!readyDatabases.has(db)) {
        ensureUpdateRunLedgerSchema(db);
      }
      committedDatabase = db;
      return operation(db);
    },
    options,
    { operationLabel: "update.run" },
  );
  if (committedDatabase && !committedDatabase.isTransaction) {
    readyDatabases.add(committedDatabase);
  }
  return result;
}

function persistRun(
  db: DatabaseSync,
  record: UpdateRunRecord,
  options: LedgerOptions,
): UpdateRunRecord {
  record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
  const row = encodeRun(record, options);
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LedgerDatabase>(db)
      .updateTable("update_runs")
      .set(row)
      .where("run_id", "=", record.runId),
  );
  return decodeRun(row);
}

function mutateRunInTransaction(
  db: DatabaseSync,
  runId: string,
  update: (record: UpdateRunRecord) => void,
  options: LedgerOptions,
): UpdateRunRecord {
  const record = readRun(db, runId);
  if (!record) {
    throw new Error(`Unknown update run: ${runId}`);
  }
  const before = JSON.stringify(record);
  update(record);
  return before === JSON.stringify(record) ? record : persistRun(db, record, options);
}

function mutateRun(
  runId: string,
  update: (record: UpdateRunRecord) => void,
  options: LedgerOptions,
): UpdateRunRecord {
  // An existing run can belong to a restored older runtime. History updates
  // must never reopen through bootstrap/migration merely to report its outcome.
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => mutateRunInTransaction(db, runId, update, options),
    options,
    { schemaSql: schema, operationLabel: "update.run" },
  );
}

export function createUpdateRun(
  input: RunPatch & {
    runId?: string;
    trigger: UpdateRunRecord["trigger"];
    supersedeStaleIdentityless?: boolean;
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
  return writeRun((db) => {
    const existing = readRun(db, row.run_id);
    if (existing) {
      return existing;
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
        upsertUpdateRunStep(previous, {
          step: "reconcile:superseded",
          status: "failed",
          endedAtMs: now,
          detail: "operator-started-update-supersedes-inactive-identityless-run",
        });
        finishUpdateRunRecord(previous, { status: "failed", reason: "superseded" });
        persistRun(db, previous, options);
      }
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<LedgerDatabase>(db).insertInto("update_runs").values(row),
    );
    return decodeRun(row);
  }, options);
}

/** Commit the RPC driver's explicit policy under the existing run transaction. */
export function declareUnprotectedGatewayUpdate(runId: string, options: LedgerOptions = {}): void {
  mutateRun(runId, declareUnprotectedGatewayUpdateRecord, options);
}

export function bindUnprotectedGatewayUpdateDriver(
  runId: string,
  options: LedgerOptions = {},
): void {
  mutateRun(runId, bindUnprotectedGatewayUpdateFinalizerRecord, options);
  adoptUpdateRun(runId, options);
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
          upsertUpdateRunStep(record, {
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
      upsertUpdateRunStep(record, {
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

/** Record the operator's successful ledger-only repair without changing the failed outcome. */
export function acknowledgeAbandonedUpdateRun(runId: string, options: LedgerOptions = {}): void {
  mutateRun(
    runId,
    (record) => {
      if (
        isAbandonedUpdateRun(record) &&
        !record.steps.some((step) => step.step === "reconcile:acknowledged")
      ) {
        upsertUpdateRunStep(record, {
          step: "reconcile:acknowledged",
          status: "completed",
          endedAtMs: Date.now(),
        });
      }
    },
    options,
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
          upsertUpdateRunStep(record, {
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
    { schemaSql: schema, operationLabel: "update.run" },
  );
}

export function recordUpdateRunPhase(
  runId: string,
  phase: UpdateRunPhase,
  patch: RunPatch & { step?: UpdateRunStep } = {},
  options: LedgerOptions = {},
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
        upsertUpdateRunStep(record, { step: record.phase, status: "completed", endedAtMs: now });
        record.phase = phase;
        upsertUpdateRunStep(record, {
          step: phase,
          status: "in_progress",
          startedAtMs: now,
          endedAtMs: undefined,
        });
      }
      if (patch.step) {
        upsertUpdateRunStep(record, patch.step);
      }
    },
    options,
  );
}

export function recordUpdateRunStep(
  runId: string,
  step: UpdateRunStep,
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      if (record.status === "running") {
        upsertUpdateRunStep(record, step);
      }
    },
    options,
  );
}

/** Exact recovery receipts share the existing run owner, outside diagnostic eviction. */
export function recordUpdateRunRecoveryCapture(
  runId: string,
  patch: Pick<UpdateRecoveryCaptureState, "manifestSha256"> & Partial<UpdateRecoveryCaptureState>,
  assertCurrent: () => void,
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      assertCurrent();
      record.origin.updateRecoveryCapture = mergeUpdateRecoveryCaptureState(
        record.origin.updateRecoveryCapture,
        patch,
      );
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
      upsertUpdateRunStep(record, {
        step: "finalize:exit",
        status: "completed",
        endedAtMs: Date.now(),
        detail,
      });
    },
    options,
  );
}

export function finishUpdateRun(
  runId: string,
  result: FinishUpdateRunResult,
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(runId, (record) => finishUpdateRunRecord(record, result), options);
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
  // The same canonical subset previously checked by the recovery writer. No bootstrap or migration.
  const interruptionSchema = ["schema_meta", "config_machine_state", "update_runs"]
    .map((table) => {
      const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      const marker = ") STRICT;";
      const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
      if (start < 0 || end < 0) {
        throw new Error("Interrupted update schema is unavailable.");
      }
      return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length);
    })
    .join("\n");
  assertCurrent();
  runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent();
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
    { schemaSql: interruptionSchema, operationLabel: "update.interrupted" },
  );
}

export function recordUpdateRunVerification(
  runId: string,
  verification: UpdateRunRecord["verification"],
  options: LedgerOptions & { onlyIfRunning?: true } = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      // Startup observations cannot revise a terminal result, including one
      // committed after the Gateway read the run but before this transaction.
      if (options.onlyIfRunning && record.status !== "running") {
        return;
      }
      record.verification = {
        ...record.verification,
        ...verification,
        ...(verification.pluginErrors
          ? { pluginErrors: verification.pluginErrors.slice(-32) }
          : {}),
      };
      if (record.status === "running" && verification.serviceRunning === false) {
        record.confirmedAtMs = null;
      }
      if (
        record.verification.serviceRunning &&
        record.verification.versionMatch &&
        record.verification.settled === true &&
        record.verification.readyz === true &&
        record.verification.channelsReady === true &&
        record.verification.pluginErrors?.length === 0 &&
        record.confirmedAtMs === null
      ) {
        record.confirmedAtMs = Date.now();
      }
    },
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
