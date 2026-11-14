import { toUSVString } from "node:util";
import { deleteExecutionOwnerLifecycleMetadata } from "../../audit/execution-owner-lifecycle-binding-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../../infra/sqlite-schema-ensure.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import {
  receiptFromRow,
  receiptHandle,
  type CronRunReceiptDatabase,
  type CronRunReceiptRow,
} from "./run-receipt-read.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import type {
  CronRunReceiptHandle,
  CronRunReceiptRecoveryCandidate,
  CronRunReceiptStatus,
} from "./run-receipt.types.js";

export { CronRunReceiptRevisionError } from "./run-receipt.types.js";

const CRON_RUN_RECEIPT_TERMINAL_RETENTION = 64;
const CRON_RUN_RECEIPT_DELETE_BATCH_SIZE = 500;
// Redundant DDL revokes profile authority retained by an active manual run.
const ensureNativeCronRunReceiptSchema = createSqliteSchemaEnsurer(
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

export function ensureCronRunReceiptSchema(database: EngineConnection): void {
  // PostgreSQL's physical schema owner admits these tables before worker operations.
  if (!isPostgresSqlConnection(database)) {
    ensureNativeCronRunReceiptSchema(database);
  }
}

function query(database: EngineConnection) {
  return getNodeSqliteKysely<CronRunReceiptDatabase>(database);
}

function activeRow(db: EngineConnection, key: string): Array<Pick<CronRunReceiptRow, "job_id">>;
function activeRow(db: EngineConnection, key: string, jobId: string): CronRunReceiptRow | undefined;
function activeRow(db: EngineConnection, key: string, jobId?: string) {
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

function pruneTerminalReceipts(
  database: EngineConnection,
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

/** The receipt key and active-job unique index arbitrate claims in one write. */
export function claimCronRunReceiptInDatabase(params: {
  database: EngineConnection;
  handle: CronRunReceiptHandle;
  requestRunId?: string;
}): CronRunReceiptHandle | undefined {
  const { handle } = params;
  const claimed = executeSqliteQueryTakeFirstSync(
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
      }))
      .onConflict((conflict) => conflict.doNothing())
      .returning("receipt_id"),
  );
  return claimed ? handle : undefined;
}

export function findActiveCronRunReceiptInDatabase(params: {
  database: EngineConnection;
  storePath: string;
  jobId: string;
}): CronRunReceiptRecoveryCandidate | undefined {
  const row = activeRow(params.database, params.storePath, params.jobId);
  return row ? receiptHandle(receiptFromRow(row)) : undefined;
}

export function listActiveCronRunReceiptJobIdsInDatabase(
  database: EngineConnection,
  storePath: string,
) {
  return new Set(activeRow(database, storePath).map((row) => row.job_id));
}

/** Advances a queued request to its execution start inside the marker transaction. */
export function activateCronRunReceiptInDatabase(params: {
  database: EngineConnection;
  handle: CronRunReceiptHandle;
  startedAtMs: number;
}): CronRunReceiptHandle {
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
  database: EngineConnection;
  receiptSchema: CronRunReceiptWriteSchema;
  handle: CronRunReceiptHandle;
  pendingReceiptId: string | undefined;
  status: Exclude<CronRunReceiptStatus, "running">;
  executionPending?: boolean;
  finishedAtMs: number;
  error?: string;
}): boolean {
  const completed = executeSqliteQuerySync(
    params.database,
    query(params.database)
      .updateTable("cron_run_receipts")
      .set({
        // A recorded timeout retains the unique active-job fence until execution settles.
        status: params.executionPending ? "running" : params.status,
        finished_at_ms: params.executionPending ? null : params.finishedAtMs,
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
