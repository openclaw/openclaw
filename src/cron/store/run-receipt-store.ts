import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import type {
  ExecutionOwnerBinding,
  ExecutionOwnerBindingResult,
} from "../../audit/execution-owner-binding.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  deleteExecutionOwnerLifecycleMetadata,
  ensureExecutionOwnerLifecycleBindingSchema,
} from "../../audit/execution-owner-lifecycle-binding-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { describeUnavailableCronAgent, type CronAgentAvailability } from "../agent-availability.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import {
  receiptFromRow,
  receiptHandle,
  type CronRunReceiptDatabase,
  type CronRunReceiptRow,
} from "./run-receipt-read.js";
import { createCronRunReceiptSettlementOwner } from "./run-receipt-settlement.js";
import {
  prepareCronRunReceiptWriteSchema,
  type CronRunReceiptWriteSchema,
} from "./run-receipt-write-admission.js";
import type {
  CronRunReceipt,
  CronRunReceiptHandle,
  CronRunReceiptOwnerObservation,
  CronRunReceiptRecoveryCandidate,
  CronRunReceiptStatus,
} from "./run-receipt.types.js";

/**
 * Receipt/lease lifecycle (the SQLite status is `running` for the first three rows):
 *
 * State            | Transition owner       | Atomic durable change                         | Dead-owner recovery
 * reserved-queued  | reservation admission  | insert receipt + set job.queuedAtMs            | sibling interrupts receipt + clears exact queued marker
 * active-running   | execution admission    | advance receipt.startedAtMs + queued→running   | sibling interrupts receipt + repairs exact running marker
 * settling         | execution/finalizer    | outcome may be recorded; lease stays running   | sibling interrupts markerless receipt or restores finalized task fact
 * terminal{ok,error,skipped,interrupted,superseded}
 *                  | finalizer/recovery      | terminalize receipt with exact marker outcome  | no recovery; retained history is bounded
 *
 * I1: Every non-terminal receipt has a live owner or is recoverable by any live sibling.
 * I2: Receipt transitions and job markers commit together, or use the recovery rule above.
 * I3: Every abandon/cleanup path terminalizes and releases its exact receipt.
 * I4: Finalization applies outcomes to the authoritative row, never an admitted snapshot.
 */

export type CronRunReceiptSettlementDisposition = "owner-unavailable";

type ResolveReceiptAgentId = (job: CronJob) => string;

type PreparedCronRunReceiptAdjudication = {
  storeKey: string;
  observed?: CronRunReceiptOwnerObservation;
  observedStale: boolean;
};

export type PreparedCronRunReceiptClaim = PreparedCronRunReceiptAdjudication & {
  handle: CronRunReceiptHandle;
  requestRunId?: string;
};

const CRON_RUN_RECEIPT_SCHEMA_START = "CREATE TABLE IF NOT EXISTS cron_run_receipts (";
const CRON_RUN_RECEIPT_SCHEMA_END =
  "ON cron_run_receipts(store_key, job_id, started_at_ms DESC, receipt_id DESC);";
const CRON_RUN_RECEIPT_TERMINAL_RETENTION = 64;
const CRON_RUN_RECEIPT_DELETE_BATCH_SIZE = 500;
/** Recovery horizon for abandoned markers and unverifiable foreign receipts. */
export const CRON_STUCK_RUN_MS = 2 * 60 * 60_000;
const initializedDatabases = new WeakSet<DatabaseSync>();
export class CronRunReceiptConflictError extends Error {
  readonly candidate: CronRunReceiptRecoveryCandidate;

  constructor(readonly receipt: CronRunReceipt) {
    super(`cron job ${receipt.jobId} is already running in process ${receipt.ownerPid}`);
    this.name = "CronRunReceiptConflictError";
    this.candidate = receiptHandle(receipt);
  }
}

export class CronRunReceiptRevisionError extends Error {
  constructor(
    readonly receiptId: string,
    message = "cron run configuration changed",
    readonly reason: "revision-changed" | "owner-unavailable" = "revision-changed",
  ) {
    super(message);
    this.name = "CronRunReceiptRevisionError";
  }
}

const settlement = createCronRunReceiptSettlementOwner({
  finishNative: (params) =>
    withReceiptWrite("cron.run-receipt.finish", params.env ? { env: params.env } : {}, (database) =>
      finishCronRunReceiptInDatabase({
        database,
        receiptSchema: prepareCronRunReceiptWriteSchema(database),
        ...params,
      }),
    ),
  revisionError: (receiptId, message) => new CronRunReceiptRevisionError(receiptId, message),
});
export const {
  trackCronRunReceiptSettlement,
  retainCronRunReceiptSettlement,
  isCronRunReceiptSettlementPending,
  finishCronRunReceipt,
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} = settlement;

export function ensureCronRunReceiptSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(CRON_RUN_RECEIPT_SCHEMA_START);
  const endMarker = OPENCLAW_STATE_SCHEMA_SQL.indexOf(CRON_RUN_RECEIPT_SCHEMA_END, start);
  if (start < 0 || endMarker < start) {
    throw new Error("OpenClaw cron run receipt schema marker is missing.");
  }
  // sqlite-allow-raw -- Canonical feature-local additive DDL only.
  database.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(start, endMarker + CRON_RUN_RECEIPT_SCHEMA_END.length),
  );
}

function query(database: DatabaseSync) {
  return getNodeSqliteKysely<CronRunReceiptDatabase>(database);
}

function activeRow(db: DatabaseSync, key: string): Array<Pick<CronRunReceiptRow, "job_id">>;
function activeRow(db: DatabaseSync, key: string, jobId: string): CronRunReceiptRow | undefined;
function activeRow(db: DatabaseSync, key: string, jobId?: string) {
  const find = () => {
    const active = query(db)
      .selectFrom("cron_run_receipts")
      .where("store_key", "=", key)
      .where("status", "=", "running");
    return jobId === undefined
      ? executeSqliteQuerySync(db, active.select("job_id")).rows
      : executeSqliteQueryTakeFirstSync(db, active.selectAll().where("job_id", "=", jobId));
  };
  try {
    return find();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "no such table: cron_run_receipts") {
      throw error;
    }
    // A direct transaction can be the first receipt user after upgrade.
    ensureCronRunReceiptSchema(db);
    return find();
  }
}

function withReceiptWrite<T>(
  operationLabel: string,
  options: OpenClawStateDatabaseOptions,
  operation: (database: DatabaseSync) => T,
): T {
  let initializedDatabase: DatabaseSync | undefined;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (!initializedDatabases.has(db)) {
        ensureCronRunReceiptSchema(db);
        initializedDatabase = db;
      }
      return operation(db);
    },
    options,
    { operationLabel },
  );
  if (initializedDatabase) {
    initializedDatabases.add(initializedDatabase);
  }
  return result;
}

/** Binds the exact admitted execution to its authoritative receipt without changing lifecycle. */
export function bindCronRunReceiptExecutionInDatabase(
  database: DatabaseSync,
  handle: CronRunReceiptHandle,
  binding: ExecutionOwnerBinding,
  receiptSchema: CronRunReceiptWriteSchema,
): ExecutionOwnerBindingResult {
  ensureCronRunReceiptSchema(database);
  try {
    assertCronRunReceiptOwnedInDatabase({ database, handle });
  } catch (error) {
    if (!(error instanceof CronRunReceiptRevisionError)) {
      throw error;
    }
    return "missing";
  }
  // Only a live exact receipt may allocate opt-in binding storage. DDL and
  // metadata remain in this admitted transaction, so refusal rolls both back.
  if (!receiptSchema.executionOwnerLifecycleBindings) {
    ensureExecutionOwnerLifecycleBindingSchema(database);
  }
  return bindExecutionOwnerLifecycleMetadata({
    db: database,
    ownerKind: "cron",
    ownerId: handle.receiptId,
    binding,
  });
}

function currentJob(database: DatabaseSync, storeKey: string, jobId: string): CronJob | undefined {
  const rows = loadCronRows(database, storeKey, new Set([jobId]));
  return loadedCronStoreFromRows(rows).store.jobs[0];
}

function sameOwner(left: CronRunReceiptRow, right: CronRunReceiptOwnerObservation): boolean {
  return (
    left.receipt_id === right.receiptId &&
    left.owner_pid === right.ownerPid &&
    left.owner_start_time === right.ownerStartTime &&
    left.started_at_ms === right.startedAtMs
  );
}

function observeOwner(row: CronRunReceiptRow): CronRunReceiptOwnerObservation {
  return {
    receiptId: row.receipt_id,
    ownerPid: row.owner_pid,
    ownerStartTime: row.owner_start_time,
    startedAtMs: row.started_at_ms,
  };
}

function ownerStale(owner: CronRunReceiptOwnerObservation, nowMs = Date.now()): boolean {
  if (owner.ownerPid === process.pid) {
    return !settlement.owns(owner.receiptId);
  }
  if (isPidDefinitelyDead(owner.ownerPid)) {
    return true;
  }
  const observedStartTime = getFileLockProcessStartTime(owner.ownerPid);
  if (owner.ownerStartTime !== null && observedStartTime !== null) {
    return owner.ownerStartTime !== observedStartTime;
  }
  // An unverifiable foreign PID cannot fence a job forever. Revoke only after
  // the stuck-run horizon; verified owners and locally held work never age out.
  return nowMs - owner.startedAtMs > CRON_STUCK_RUN_MS;
}

function validateCurrentJob(params: {
  database: DatabaseSync;
  handle: Pick<
    CronRunReceiptHandle,
    "agentId" | "configRevision" | "jobId" | "receiptId" | "storeKey"
  >;
  resolveAgentId: ResolveReceiptAgentId;
}): CronJob {
  const job = currentJob(params.database, params.handle.storeKey, params.handle.jobId);
  if (!job) {
    throw new CronRunReceiptRevisionError(params.handle.receiptId, "cron job was removed");
  }
  if (params.resolveAgentId(job) !== params.handle.agentId) {
    throw new CronRunReceiptRevisionError(params.handle.receiptId);
  }
  return job;
}

function pruneTerminalReceipts(
  database: DatabaseSync,
  storeKey: string,
  jobId: string,
  job: CronJob | undefined,
  receiptSchema: CronRunReceiptWriteSchema,
): void {
  const pendingReceiptId =
    job?.state.runningAtMs === undefined ? undefined : job.state.runningReceiptId;
  let terminalQuery = query(database)
    .selectFrom("cron_run_receipts")
    .select("receipt_id")
    .where("store_key", "=", storeKey)
    .where("job_id", "=", jobId)
    .where("status", "!=", "running");
  // JSON state must match SQLite TEXT without coercion or surrogate replacement.
  if (typeof pendingReceiptId === "string" && toUSVString(pendingReceiptId) === pendingReceiptId) {
    terminalQuery = terminalQuery.orderBy(
      (eb) => eb.case().when("receipt_id", "=", pendingReceiptId).then(1).else(0).end(),
      "desc",
    );
  }
  const terminalIds = executeSqliteQuerySync(
    database,
    terminalQuery
      .orderBy("finished_at_ms", "desc")
      .orderBy("started_at_ms", "desc")
      .orderBy("receipt_id", "desc")
      .limit(-1)
      .offset(CRON_RUN_RECEIPT_TERMINAL_RETENTION),
  ).rows;
  for (let index = 0; index < terminalIds.length; index += CRON_RUN_RECEIPT_DELETE_BATCH_SIZE) {
    const receiptIds = terminalIds
      .slice(index, index + CRON_RUN_RECEIPT_DELETE_BATCH_SIZE)
      .map((row) => row.receipt_id);
    deleteExecutionOwnerLifecycleMetadata({
      db: database,
      ownerKind: "cron",
      ownerIds: receiptIds,
      executionOwnerLifecycleBindings: receiptSchema.executionOwnerLifecycleBindings,
    });
    executeSqliteQuerySync(
      database,
      query(database)
        .deleteFrom("cron_run_receipts")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", jobId)
        .where("status", "!=", "running")
        .where("receipt_id", "in", receiptIds),
    );
  }
}

/** Prepares process liveness facts before the caller enters its commit transaction. */
export function prepareCronRunReceiptAdjudication(params: {
  storePath: string;
  jobId: string;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}): PreparedCronRunReceiptAdjudication {
  const storeKey = cronStoreKey(params.storePath);
  const options = params.env ? { env: params.env } : {};
  const observed = withReceiptWrite("cron.run-receipt.inspect", options, (database) =>
    activeRow(database, storeKey, params.jobId),
  );
  return {
    storeKey,
    ...(observed ? { observed: observeOwner(observed) } : {}),
    observedStale: observed ? ownerStale(observeOwner(observed), params.nowMs) : false,
  };
}

export function prepareCronRunReceiptClaim(params: {
  storePath: string;
  job: CronJob;
  agentId: string;
  startedAtMs: number;
  requestRunId?: string;
  env?: NodeJS.ProcessEnv;
}): PreparedCronRunReceiptClaim {
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  if (ownerStartTime === null) {
    throw new Error("cron run cannot acquire a durable fence without process start identity");
  }
  const adjudication = prepareCronRunReceiptAdjudication({
    storePath: params.storePath,
    jobId: params.job.id,
    nowMs: params.startedAtMs,
    env: params.env,
  });
  const storeKey = cronStoreKey(params.storePath);
  const handle: CronRunReceiptHandle = {
    receiptId: crypto.randomUUID(),
    storeKey,
    jobId: params.job.id,
    configRevision: resolveCronJobConfigRevision(params.job),
    agentId: params.agentId,
    ownerPid: process.pid,
    ownerStartTime,
    startedAtMs: params.startedAtMs,
  };
  return {
    handle,
    ...adjudication,
    ...(params.requestRunId ? { requestRunId: params.requestRunId } : {}),
  };
}

/** Rechecks the owner and phase start so activation invalidates an age-based stale decision. */
export function adjudicateActiveCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  jobId: string;
  prepared: PreparedCronRunReceiptAdjudication;
  finishedAtMs: number;
}): void {
  const current = activeRow(params.database, params.prepared.storeKey, params.jobId);
  if (!current) {
    return;
  }
  if (
    params.prepared.observed &&
    params.prepared.observedStale &&
    sameOwner(current, params.prepared.observed)
  ) {
    executeSqliteQuerySync(
      params.database,
      query(params.database)
        .updateTable("cron_run_receipts")
        .set({
          status: "interrupted",
          finished_at_ms: params.finishedAtMs,
          error_text: "cron: job interrupted because owner is unavailable",
        })
        .where("receipt_id", "=", current.receipt_id)
        .where("status", "=", "running"),
    );
    return;
  }
  throw new CronRunReceiptConflictError(receiptFromRow(current));
}

/** Claims the receipt inside the caller's synchronous cron-state transaction. */
export function claimCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  prepared: PreparedCronRunReceiptClaim;
  receiptSchema: CronRunReceiptWriteSchema;
  resolveAgentId: ResolveReceiptAgentId;
}): CronRunReceiptHandle {
  const { handle } = params.prepared;
  if (handle.ownerStartTime === null) {
    throw new Error("cron run cannot acquire a durable fence without process start identity");
  }
  adjudicateActiveCronRunReceiptInDatabase({
    database: params.database,
    jobId: handle.jobId,
    prepared: params.prepared,
    finishedAtMs: handle.startedAtMs,
  });
  const job = validateCurrentJob({
    database: params.database,
    handle,
    resolveAgentId: params.resolveAgentId,
  });
  pruneTerminalReceipts(params.database, handle.storeKey, handle.jobId, job, params.receiptSchema);
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .insertInto("cron_run_receipts")
      .values({
        receipt_id: handle.receiptId,
        store_key: handle.storeKey,
        job_id: handle.jobId,
        config_revision: handle.configRevision,
        agent_id: handle.agentId,
        request_run_id: params.prepared.requestRunId ?? null,
        status: "running",
        owner_pid: handle.ownerPid,
        owner_start_time: handle.ownerStartTime,
        started_at_ms: handle.startedAtMs,
        finished_at_ms: null,
        error_text: null,
      }),
  );
  const claimed = receiptHandle(
    receiptFromRow(activeRow(params.database, handle.storeKey, handle.jobId)!),
  );
  settlement.claim(claimed.receiptId);
  return claimed;
}

export function findActiveCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  storePath: string;
  jobId: string;
}): CronRunReceiptRecoveryCandidate | undefined {
  const row = activeRow(params.database, cronStoreKey(params.storePath), params.jobId);
  return row ? receiptHandle(receiptFromRow(row)) : undefined;
}

export function listActiveCronRunReceiptJobIdsInDatabase(
  database: DatabaseSync,
  storePath: string,
) {
  return new Set(activeRow(database, cronStoreKey(storePath)).map((row) => row.job_id));
}

export function exactCronRunReceiptMatches(
  current: CronRunReceiptRecoveryCandidate | undefined,
  proposed: CronRunReceiptRecoveryCandidate,
): boolean {
  return (
    current?.receiptId === proposed.receiptId &&
    current.ownerPid === proposed.ownerPid &&
    current.ownerStartTime === proposed.ownerStartTime &&
    current.storeKey === proposed.storeKey &&
    current.jobId === proposed.jobId &&
    current.startedAtMs === proposed.startedAtMs
  );
}

export function isCronRunReceiptOwnerStale(
  candidate: CronRunReceiptOwnerObservation | CronRunReceiptHandle,
  nowMs = Date.now(),
): boolean {
  return ownerStale(candidate, nowMs);
}

/** Synchronous transaction guard used immediately before a run side effect or state write. */
export function assertCronRunReceiptOwnedInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
}): void {
  const current = activeRow(params.database, params.handle.storeKey, params.handle.jobId);
  if (
    !current ||
    current.receipt_id !== params.handle.receiptId ||
    current.owner_pid !== params.handle.ownerPid ||
    current.owner_start_time !== params.handle.ownerStartTime
  ) {
    throw new CronRunReceiptRevisionError(
      params.handle.receiptId,
      "cron run fence is no longer current",
    );
  }
}

/** Synchronous transaction guard used immediately before a run side effect or state write. */
export function assertCronRunReceiptCurrentInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId;
}): void {
  assertCronRunReceiptOwnedInDatabase(params);
  validateCurrentJob({
    database: params.database,
    handle: params.handle,
    resolveAgentId: params.resolveAgentId,
  });
}

/** Advances a queued lease to its execution start inside the marker transaction. */
export function activateCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  startedAtMs: number;
  resolveAgentId: ResolveReceiptAgentId;
}): CronRunReceiptHandle {
  assertCronRunReceiptCurrentInDatabase(params);
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .updateTable("cron_run_receipts")
      .set({ started_at_ms: params.startedAtMs })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("status", "=", "running"),
  );
  return { ...params.handle, startedAtMs: params.startedAtMs };
}

/** Reads the canonical definition under the same exact receipt check used by execution. */
export function readCronRunReceiptCurrentJob(params: {
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId;
  isAgentAvailable?: CronAgentAvailability;
  allowMissingJob?: boolean;
  env?: NodeJS.ProcessEnv;
}): CronJob | undefined {
  return withReceiptWrite(
    "cron.run-receipt.assert-current",
    params.env ? { env: params.env } : {},
    (database) => {
      if (params.isAgentAvailable?.(params.handle.agentId, database) === false) {
        throw new CronRunReceiptRevisionError(
          params.handle.receiptId,
          describeUnavailableCronAgent(params.handle.agentId, params.env),
          "owner-unavailable",
        );
      }
      assertCronRunReceiptOwnedInDatabase({ database, handle: params.handle });
      return params.allowMissingJob ? undefined : validateCurrentJob({ database, ...params });
    },
  );
}

export function assertCronRunReceiptCurrent(
  params: Parameters<typeof readCronRunReceiptCurrentJob>[0],
): void {
  readCronRunReceiptCurrentJob(params);
}

/** Completes the exact active receipt inside its caller's cron-state transaction. */
export function finishCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  receiptSchema: CronRunReceiptWriteSchema;
  handle: CronRunReceiptHandle;
  status: Exclude<CronRunReceiptStatus, "running">;
  finishedAtMs: number;
  error?: string;
}): CronRunReceipt | undefined {
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .updateTable("cron_run_receipts")
      .set({
        status: params.status,
        finished_at_ms: params.finishedAtMs,
        error_text: params.error ?? null,
      })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("status", "=", "running")
      .where("owner_pid", "=", params.handle.ownerPid),
  );
  pruneTerminalReceipts(
    params.database,
    params.handle.storeKey,
    params.handle.jobId,
    currentJob(params.database, params.handle.storeKey, params.handle.jobId),
    params.receiptSchema,
  );
  const row = executeSqliteQueryTakeFirstSync(
    params.database,
    query(params.database)
      .selectFrom("cron_run_receipts")
      .selectAll()
      .where("receipt_id", "=", params.handle.receiptId),
  );
  return row ? receiptFromRow(row) : undefined;
}
