import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { deleteExecutionOwnerLifecycleMetadata } from "../../audit/execution-owner-lifecycle-binding-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { createSqliteSchemaEnsurer } from "../../infra/sqlite-schema-ensure.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import type { CronJob } from "../types.js";
import {
  CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE,
  hasCanonicalCronDeliveryMode,
} from "./delivery-codec.js";
import { cronStoreKey } from "./key.js";
import {
  receiptFromRow,
  receiptHandle,
  type CronRunReceiptDatabase,
  type CronRunReceiptRow,
} from "./run-receipt-read.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { CronRunReceiptRevisionError } from "./run-receipt.types.js";
import type {
  CronRunReceiptHandle,
  CronRunReceiptRecoveryCandidate,
  CronRunReceiptStatus,
} from "./run-receipt.types.js";

export { CronRunReceiptRevisionError } from "./run-receipt.types.js";

/** The worker owns request, activation and terminal receipt transitions. */
type ResolveReceiptAgentId<Job = CronJob> = (job: Job) => string;

const CRON_RUN_RECEIPT_TERMINAL_RETENTION = 64;
const CRON_RUN_RECEIPT_DELETE_BATCH_SIZE = 500;
// Redundant DDL revokes profile authority retained by an active manual run.
export const ensureCronRunReceiptSchema = createSqliteSchemaEnsurer(
  () =>
    getOpenClawStateFeatureSchemaSql("cron_run_receipts", {
      endMarker: "ON cron_run_receipts(store_key, job_id, started_at_ms DESC, receipt_id DESC);",
      errorMessage: "OpenClaw cron run receipt schema marker is missing.",
    }),
  {
    tables: ["cron_run_receipts"],
    indexes: ["idx_cron_run_receipts_active_job", "idx_cron_run_receipts_job_history"],
  },
);

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
  pendingReceiptId: string | undefined,
  receiptSchema: CronRunReceiptWriteSchema,
): void {
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
      // SQLite requires a LIMIT for OFFSET; this bound exceeds any realizable receipt set.
      .limit(Number.MAX_SAFE_INTEGER)
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

/** Inserts a receipt after the queue has admitted its current job and free slot. */
export function claimCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  job: CronJob | undefined;
  requestRunId?: string;
  receiptSchema: CronRunReceiptWriteSchema;
  resolveAgentId: ResolveReceiptAgentId;
}): CronRunReceiptHandle {
  const { handle } = params;
  const job = validateCurrentReceiptJob(params.job, params);
  assertCronRunDelivery(hasCanonicalCronDeliveryMode(job.delivery), handle.receiptId);
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .insertInto("cron_run_receipts")
      .values((eb) => ({
        cursor_id: eb
          .selectFrom("cron_run_receipts")
          .select((inner) =>
            inner(inner.fn.coalesce(inner.fn.max<number>("cursor_id"), inner.val(0)), "+", 1).as(
              "cursor_id",
            ),
          ),
        receipt_id: handle.receiptId,
        store_key: handle.storeKey,
        job_id: handle.jobId,
        config_revision: handle.configRevision,
        agent_id: handle.agentId,
        request_run_id: params.requestRunId ?? null,
        delivery_attempt_state: "not-started",
        status: "running",
        owner_pid: handle.ownerPid,
        owner_start_time: handle.ownerStartTime,
        started_at_ms: handle.startedAtMs,
        finished_at_ms: null,
        error_text: null,
      })),
  );
  return { ...handle };
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

/** Advances a queued request to its execution start inside the marker transaction. */
export function activateCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  handle: CronRunReceiptHandle;
  job: CronJob;
  startedAtMs: number;
  resolveAgentId: ResolveReceiptAgentId;
}): CronRunReceiptHandle {
  const job = validateCurrentReceiptJob(params.job, params);
  assertCronRunDelivery(hasCanonicalCronDeliveryMode(job.delivery), params.handle.receiptId);
  executeSqliteQuerySync(
    params.database,
    query(params.database)
      .updateTable("cron_run_receipts")
      .set({
        config_revision: params.handle.configRevision,
        agent_id: params.handle.agentId,
        owner_pid: params.handle.ownerPid,
        owner_start_time: params.handle.ownerStartTime,
        started_at_ms: params.startedAtMs,
      })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("status", "=", "running"),
  );
  return { ...params.handle, startedAtMs: params.startedAtMs };
}

/** Completes the exact active receipt inside its caller's cron-state transaction. */
export function finishCronRunReceiptInDatabase(params: {
  database: DatabaseSync;
  receiptSchema: CronRunReceiptWriteSchema;
  handle: CronRunReceiptHandle;
  pendingReceiptId: string | undefined;
  status: Exclude<CronRunReceiptStatus, "running">;
  finishedAtMs: number;
  error?: string;
}): boolean {
  const completed = executeSqliteQuerySync(
    params.database,
    query(params.database)
      .updateTable("cron_run_receipts")
      .set({
        status: params.status,
        finished_at_ms: params.finishedAtMs,
        error_text: params.error ?? null,
      })
      .where("receipt_id", "=", params.handle.receiptId)
      .where("status", "=", "running"),
  );
  if (!completed.numAffectedRows) {
    return false;
  }
  pruneTerminalReceipts(
    params.database,
    params.handle.storeKey,
    params.handle.jobId,
    params.pendingReceiptId,
    params.receiptSchema,
  );
  return true;
}
