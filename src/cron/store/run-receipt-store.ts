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
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { describeUnavailableCronAgent, type CronAgentAvailability } from "../agent-availability.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { CronAgentScope } from "../types-shared.js";
import type { CronJob } from "../types.js";
import {
  CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE,
  hasCanonicalCronDeliveryMode,
} from "./delivery-codec.js";
import { cronStoreKey } from "./key.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import {
  matchesCronRunReceiptOwner,
  receiptFromRow,
  receiptHandle,
  type CronRunReceiptDatabase,
  type CronRunReceiptRow,
} from "./run-receipt-read.js";
import { createCronRunReceiptSettlementOwner } from "./run-receipt-settlement.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type {
  CronRunReceipt,
  CronRunReceiptCurrentFacts,
  CronRunReceiptHandle,
  CronRunReceiptOwnerObservation,
  CronRunReceiptRecoveryCandidate,
  CronRunReceiptStatus,
  PreparedCronRunReceiptAdjudication,
  PreparedCronRunReceiptClaim,
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

type ResolveReceiptAgentId<Job = CronJob> = (job: Job) => string;

type CronReceiptCurrentPolicy<Job = CronJob> = {
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId<Job>;
  isAgentAvailable?: CronAgentAvailability;
  allowMissingJob?: boolean;
  env?: NodeJS.ProcessEnv;
};

const CRON_RUN_RECEIPT_TERMINAL_RETENTION = 64;
const CRON_RUN_RECEIPT_DELETE_BATCH_SIZE = 500;
/** Recovery horizon for abandoned markers and unverifiable foreign receipts. */
export const CRON_STUCK_RUN_MS = 2 * 60 * 60_000;
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
  revisionError: (receiptId, message) => new CronRunReceiptRevisionError(receiptId, message),
});
export const {
  claimLocalCronRunReceiptOwnership,
  listLocallyOwnedCronRunReceiptIds,
  trackCronRunReceiptSettlement,
  retainCronRunReceiptSettlement,
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} = settlement;

export function ensureCronRunReceiptSchema(database: DatabaseSync): void {
  // sqlite-allow-raw -- Canonical feature-local additive DDL only.
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "cron_run_receipts", {
      endMarker: "ON cron_run_receipts(store_key, job_id, started_at_ms DESC, receipt_id DESC);",
      errorMessage: "OpenClaw cron run receipt schema marker is missing.",
    }),
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
  return validateCurrentReceiptJob(job, params);
}

function validateCurrentReceiptJob<Job>(
  job: Job | undefined,
  params: {
    handle: Pick<CronRunReceiptHandle, "agentId" | "receiptId">;
    resolveAgentId: ResolveReceiptAgentId<Job>;
  },
): Job {
  if (!job) {
    throw new CronRunReceiptRevisionError(params.handle.receiptId, "cron job was removed");
  }
  if (params.resolveAgentId(job) !== params.handle.agentId) {
    throw new CronRunReceiptRevisionError(params.handle.receiptId);
  }
  return job;
}

function assertCronRunDelivery(hasCanonicalMode: boolean, receiptId: string): void {
  if (!hasCanonicalMode) {
    throw new CronRunReceiptRevisionError(receiptId, CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE);
  }
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
  observed: CronRunReceiptOwnerObservation | undefined;
  nowMs?: number;
}): PreparedCronRunReceiptAdjudication {
  const { observed } = params;
  return {
    storeKey: cronStoreKey(params.storePath),
    ...(observed ? { observed } : {}),
    observedStale: observed ? ownerStale(observed, params.nowMs) : false,
  };
}

export function prepareCronRunReceiptClaim(params: {
  storePath: string;
  job: CronJob;
  agentId: string;
  startedAtMs: number;
  requestRunId?: string;
  observed: CronRunReceiptOwnerObservation | undefined;
}): PreparedCronRunReceiptClaim {
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  if (ownerStartTime === null) {
    throw new Error("cron run cannot acquire a durable fence without process start identity");
  }
  const adjudication = prepareCronRunReceiptAdjudication({
    storePath: params.storePath,
    observed: params.observed,
    nowMs: params.startedAtMs,
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
  assertCronRunDelivery(hasCanonicalCronDeliveryMode(job.delivery), handle.receiptId);
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
        delivery_attempt_state: "not-started",
        status: "running",
        owner_pid: handle.ownerPid,
        owner_start_time: handle.ownerStartTime,
        started_at_ms: handle.startedAtMs,
        finished_at_ms: null,
        error_text: null,
      }),
  );
  return receiptHandle(receiptFromRow(activeRow(params.database, handle.storeKey, handle.jobId)!));
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
  assertReceiptOwner(current ? receiptHandle(receiptFromRow(current)) : undefined, params.handle);
}

function assertReceiptOwner(
  current: CronRunReceiptHandle | undefined,
  handle: CronRunReceiptHandle,
): void {
  if (!matchesCronRunReceiptOwner(current, handle)) {
    throw new CronRunReceiptRevisionError(handle.receiptId, "cron run fence is no longer current");
  }
}

/** Synchronous transaction guard used immediately before a run side effect or state write. */
export function assertCronRunReceiptCurrentInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  resolveAgentId: ResolveReceiptAgentId;
}): CronJob {
  assertCronRunReceiptOwnedInDatabase(params);
  return validateCurrentJob({
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
  const job = assertCronRunReceiptCurrentInDatabase(params);
  assertCronRunDelivery(hasCanonicalCronDeliveryMode(job.delivery), params.handle.receiptId);
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

function assertReceiptAgentAvailable(
  params: Pick<CronReceiptCurrentPolicy, "handle" | "isAgentAvailable" | "env">,
  facts: Parameters<CronAgentAvailability>[2],
) {
  if (params.isAgentAvailable?.(params.handle.agentId, undefined, facts) === false) {
    throw new CronRunReceiptRevisionError(
      params.handle.receiptId,
      describeUnavailableCronAgent(params.handle.agentId, params.env),
      "owner-unavailable",
    );
  }
}

export function assertCronRunReceiptCurrentFacts(
  params: CronReceiptCurrentPolicy<CronAgentScope> & {
    facts: CronRunReceiptCurrentFacts | undefined;
  },
): void {
  if (!params.facts) {
    throw new CronRunReceiptRevisionError(
      params.handle.receiptId,
      "cron run fence is no longer current",
    );
  }
  assertReceiptAgentAvailable(params, { deletionBlocked: params.facts.deletionBlocked });
  assertReceiptOwner(params.facts.receipt, params.handle);
  if (!params.allowMissingJob) {
    const job = validateCurrentReceiptJob(params.facts.job, params);
    assertCronRunDelivery(job.hasCanonicalDeliveryMode, params.handle.receiptId);
  }
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
