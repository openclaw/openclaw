import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asFiniteNumber, asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { estimateAcpEventRowBytes, estimateAcpSessionRowBytes } from "../acp/event-ledger-bytes.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { createSqliteTableContractReader } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  compactLegacyDeliveryQueueFailures,
  hasLegacyDeliveryQueueFailureCompactionWork,
} from "./openclaw-state-db-delivery-queue-backfill.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

const OPERATOR_APPROVAL_RESOLUTION_REF_INDEX = "idx_operator_approvals_resolution_ref";

/** The transport reference each approval row must carry; invalid rows refuse the repair. */
function* operatorApprovalResolutionRefs(db: DatabaseSync) {
  const rows = db.prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals").all();
  for (const row of rows) {
    if (
      typeof row.approval_id !== "string" ||
      !operatorApprovalMigration.isCanonicalOperatorApprovalKind(row.kind)
    ) {
      throw new Error("operator approval row cannot be assigned a transport reference");
    }
    const resolutionRef = buildApprovalResolutionRef({
      approvalId: row.approval_id,
      approvalKind: row.kind,
    });
    yield { approvalId: row.approval_id, resolutionRef, current: row.resolution_ref };
  }
}

function hasOperatorApprovalResolutionRefConflict(db: DatabaseSync): boolean {
  return (
    db
      .prepare(
        `SELECT canonical.approval_id
         FROM operator_approvals AS canonical
         JOIN operator_approvals AS referenced
           ON canonical.approval_id = referenced.resolution_ref
         WHERE canonical.approval_id <> referenced.approval_id
         LIMIT 1`,
      )
      .get() !== undefined
  );
}

export function ensureOperatorApprovalResolutionRefs(db: DatabaseSync): void {
  if (!tableExists(db, "operator_approvals")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    ensureColumn(db, "operator_approvals", "resolution_ref TEXT");
    const update = db.prepare(
      "UPDATE operator_approvals SET resolution_ref = ? WHERE approval_id = ?",
    );
    for (const row of operatorApprovalResolutionRefs(db)) {
      if (row.current !== row.resolutionRef) {
        update.run(row.resolutionRef, row.approvalId);
      }
    }
    if (hasOperatorApprovalResolutionRefConflict(db)) {
      throw new Error("operator approval ids conflict with durable transport references");
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${OPERATOR_APPROVAL_RESOLUTION_REF_INDEX}
        ON operator_approvals(resolution_ref);
    `);
  });
}

/**
 * Read-only: whether {@link ensureOperatorApprovalResolutionRefs} would add the column,
 * rewrite a reference, create its index, or refuse (an invalid row or a conflict).
 */
export function hasOperatorApprovalResolutionRefWork(db: DatabaseSync): boolean {
  if (!tableExists(db, "operator_approvals")) {
    return false;
  }
  if (!tableHasColumn(db, "operator_approvals", "resolution_ref")) {
    return true;
  }
  try {
    for (const row of operatorApprovalResolutionRefs(db)) {
      if (row.current !== row.resolutionRef) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return (
    hasOperatorApprovalResolutionRefConflict(db) ||
    !createSqliteTableContractReader(db)("operator_approvals")?.indexes.some(
      (index) => index.name === OPERATOR_APPROVAL_RESOLUTION_REF_INDEX,
    )
  );
}

type LegacyRetainedResultRow = {
  run_id: string;
  payload_json: string;
  pending_final_delivery_payload_json?: string | null;
};

function nullableTextValue(record: Record<string, unknown> | null, key: string) {
  if (!record || !Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" || value === null ? value : undefined;
}

/** The payload each shipped retained-result row is rewritten to, in row order. */
function* legacySubagentRetainedResultRewrites(db: DatabaseSync) {
  const hasLegacyPendingPayload = tableHasColumn(
    db,
    "subagent_runs",
    "pending_final_delivery_payload_json",
  );
  const rows = db
    .prepare(
      hasLegacyPendingPayload
        ? "SELECT run_id, payload_json, pending_final_delivery_payload_json FROM subagent_runs"
        : "SELECT run_id, payload_json FROM subagent_runs",
    )
    .all() as LegacyRetainedResultRow[];
  for (const row of rows) {
    const stored = safeParseJsonRecord(row.payload_json) ?? null;
    const parent = stored ? asNullableRecord(stored.parentCompletion) : null;
    const payload = parent?.completionTarget === "parent" ? parent : stored;
    const completion = payload ? asNullableRecord(payload.completion) : null;
    if (!payload || !completion) {
      continue;
    }
    const delivery = asNullableRecord(payload.delivery);
    const deliveryPayload = delivery ? asNullableRecord(delivery.payload) : null;
    const pendingPayload = row.pending_final_delivery_payload_json
      ? (safeParseJsonRecord(row.pending_final_delivery_payload_json) ?? null)
      : null;
    const hasLegacyResult = Boolean(
      (deliveryPayload &&
        (Object.hasOwn(deliveryPayload, "frozenResultText") ||
          Object.hasOwn(deliveryPayload, "fallbackFrozenResultText"))) ||
      (pendingPayload &&
        (Object.hasOwn(pendingPayload, "frozenResultText") ||
          Object.hasOwn(pendingPayload, "fallbackFrozenResultText"))),
    );
    if (!hasLegacyResult) {
      continue;
    }
    const legacyPrimary =
      nullableTextValue(deliveryPayload, "frozenResultText") ??
      nullableTextValue(pendingPayload, "frozenResultText");
    const legacyFallback =
      nullableTextValue(deliveryPayload, "fallbackFrozenResultText") ??
      nullableTextValue(pendingPayload, "fallbackFrozenResultText");
    if (nullableTextValue(completion, "resultText") == null && legacyPrimary !== undefined) {
      completion.resultText = legacyPrimary;
    }
    if (
      nullableTextValue(completion, "fallbackResultText") == null &&
      legacyFallback !== undefined
    ) {
      completion.fallbackResultText = legacyFallback;
    }
    delete deliveryPayload?.frozenResultText;
    delete deliveryPayload?.fallbackFrozenResultText;
    yield { runId: row.run_id, payloadJson: JSON.stringify(stored), current: row.payload_json };
  }
}

/** Read-only: whether {@link repairLegacySubagentRetainedResults} would change a payload. */
export function hasLegacySubagentRetainedResultWork(db: DatabaseSync): boolean {
  if (!tableExists(db, "subagent_runs")) {
    return false;
  }
  for (const rewrite of legacySubagentRetainedResultRewrites(db)) {
    if (rewrite.payloadJson !== rewrite.current) {
      return true;
    }
  }
  return false;
}

/** Promote shipped retained results before runtime hydrates canonical subagent state. */
export function repairLegacySubagentRetainedResults(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  const repair = () => {
    const updateRun = db.prepare(
      `UPDATE subagent_runs
          SET payload_json = ?
        WHERE run_id = ?`,
    );
    for (const rewrite of legacySubagentRetainedResultRewrites(db)) {
      updateRun.run(rewrite.payloadJson, rewrite.runId);
    }
  };
  if (db.isTransaction) {
    repair();
    return;
  }
  runSqliteImmediateTransactionSync(db, repair);
}

// Rows whose root terminal fields the repair below moves; matching rows always change.
const LEGACY_SUBAGENT_EXECUTION_PAYLOAD_WHERE = `
    WHERE json_valid(payload_json)
      AND (json_type(payload_json, '$.startedAt') IS NOT NULL
        OR json_type(payload_json, '$.endedAt') IS NOT NULL
        OR json_type(payload_json, '$.outcome') IS NOT NULL)`;

/** Read-only: whether {@link repairLegacySubagentExecutionPayloads} has a row to rewrite. */
export function hasLegacySubagentExecutionPayloadWork(db: DatabaseSync): boolean {
  return (
    tableExists(db, "subagent_runs") &&
    db
      .prepare(`SELECT 1 FROM subagent_runs ${LEGACY_SUBAGENT_EXECUTION_PAYLOAD_WHERE} LIMIT 1`)
      .get() !== undefined
  );
}

/** Canonicalize shipped subagent rows whose pause/kill owner only wrote root terminal fields. */
export function repairLegacySubagentExecutionPayloads(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  db.exec(`
    UPDATE subagent_runs
    SET payload_json = json_remove(
      CASE
        WHEN json_extract(payload_json, '$.pauseReason') = 'sessions_yield'
          AND json_extract(payload_json, '$.execution.status') <> 'terminal'
          AND json_type(payload_json, '$.endedAt') IN ('integer', 'real')
        THEN json_remove(json_set(
          payload_json,
          '$.execution.status', 'terminal',
          '$.execution.endedAt', json_extract(payload_json, '$.endedAt')
        ), '$.execution.outcome')
        WHEN (json_type(payload_json, '$.killReconciliation') = 'object'
          OR json_extract(payload_json, '$.endedReason') = 'subagent-killed')
          AND json_extract(payload_json, '$.execution.status') <> 'terminal'
          AND json_type(payload_json, '$.endedAt') IN ('integer', 'real')
          AND json_type(payload_json, '$.outcome') = 'object'
        THEN json_set(
          payload_json,
          '$.execution.status', 'terminal',
          '$.execution.endedAt', json_extract(payload_json, '$.endedAt'),
          '$.execution.outcome', json_extract(payload_json, '$.outcome')
        )
        ELSE payload_json
      END,
      '$.startedAt', '$.endedAt', '$.outcome'
    )
    ${LEGACY_SUBAGENT_EXECUTION_PAYLOAD_WHERE};
  `);
}

const ACP_REPLAY_ACCOUNTING_COMPLETION_KEY = "state.repair.acpReplayUtf8Accounting";

/**
 * Read-only: whether a repair-scope {@link backfillAcpReplayEstimatedBytes} would recount.
 * Its recorded completion skips the recount; without that row it recounts and records it.
 */
export function hasAcpReplayEstimatedBytesWork(db: DatabaseSync): boolean {
  if (
    !tableExists(db, "acp_replay_events") ||
    !tableHasColumn(db, "acp_replay_events", "estimated_bytes")
  ) {
    return false;
  }
  return (
    !tableExists(db, "config_machine_state") ||
    db
      .prepare("SELECT 1 FROM config_machine_state WHERE state_key = ?")
      .get(ACP_REPLAY_ACCOUNTING_COMPLETION_KEY) === undefined
  );
}

export function backfillAcpReplayEstimatedBytes(db: DatabaseSync, columnsAdded = false): void {
  if (
    !tableExists(db, "acp_replay_events") ||
    !tableHasColumn(db, "acp_replay_events", "estimated_bytes")
  ) {
    return;
  }
  const completionKey = ACP_REPLAY_ACCOUNTING_COMPLETION_KEY;
  const completionDb = tableExists(db, "config_machine_state")
    ? getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "config_machine_state">>(db)
    : undefined;
  if (
    !columnsAdded &&
    completionDb &&
    executeSqliteQueryTakeFirstSync(
      db,
      completionDb
        .selectFrom("config_machine_state")
        .select("state_key")
        .where("state_key", "=", completionKey),
    )
  ) {
    return;
  }
  // The schema/Doctor owner holds the transaction. Stream canonical text in Node
  // so UTF-16 databases, NUL and existing JSON formatting use the writer's units.
  const replayDb =
    getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "acp_replay_events" | "acp_replay_sessions">
    >(db);
  const updateEvent = db.prepare(
    "UPDATE acp_replay_events SET estimated_bytes = ? WHERE session_id = ? AND seq = ?",
  );
  for (const row of iterateSqliteQuerySync(
    db,
    replayDb
      .selectFrom("acp_replay_events")
      .select(["session_id", "seq", "session_key", "run_id", "update_json", "estimated_bytes"]),
  )) {
    const expected = estimateAcpEventRowBytes({
      sessionId: row.session_id,
      sessionKey: row.session_key,
      runId: row.run_id,
      updateJson: row.update_json,
    });
    if (sqliteNumber(row.estimated_bytes) !== expected) {
      updateEvent.run(expected, row.session_id, row.seq);
    }
  }
  const updateSession = db.prepare(
    "UPDATE acp_replay_sessions SET estimated_bytes = ? WHERE session_id = ?",
  );
  for (const row of iterateSqliteQuerySync(
    db,
    replayDb
      .selectFrom("acp_replay_sessions as s")
      .select(["s.session_id", "s.session_key", "s.cwd", "s.estimated_bytes"])
      .select((eb) =>
        eb.fn
          .coalesce(
            eb
              .selectFrom("acp_replay_events as e")
              .select((events) => events.fn.sum<number>("e.estimated_bytes").as("total"))
              .whereRef("e.session_id", "=", "s.session_id"),
            eb.val(0),
          )
          .as("event_bytes"),
      ),
  )) {
    const expected =
      estimateAcpSessionRowBytes({
        sessionId: row.session_id,
        sessionKey: row.session_key,
        cwd: row.cwd,
      }) + sqliteNumber(row.event_bytes);
    if (sqliteNumber(row.estimated_bytes) !== expected) {
      updateSession.run(expected, row.session_id);
    }
  }
  if (completionDb) {
    executeSqliteQuerySync(
      db,
      completionDb
        .insertInto("config_machine_state")
        .values({ state_key: completionKey, value_json: "true", updated_at_ms: Date.now() })
        .onConflict((conflict) => conflict.column("state_key").doNothing()),
    );
  }
}

export function backfillCronRunLogEntryJson(db: DatabaseSync): void {
  if (!tableExists(db, "cron_run_logs") || !tableHasColumn(db, "cron_run_logs", "entry_json")) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, seq, ts
         FROM cron_run_logs
        WHERE entry_json = '{}'`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    seq: number | bigint;
    ts: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_run_logs
        SET entry_json = ?
      WHERE store_key = ? AND job_id = ? AND seq = ?`,
  );
  for (const row of rows) {
    update.run(
      JSON.stringify({ ts: sqliteNumber(row.ts), jobId: row.job_id, action: "finished" }),
      row.store_key,
      row.job_id,
      row.seq,
    );
  }
}

function textField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

type CronJobProjection = {
  name: string;
  enabled: 0 | 1;
  agentId: string | null;
  payloadKind: string;
  runtimeUpdatedAtMs: number;
};

/** The query-bearing projection each legacy cron job row is rewritten to, in row order. */
function* cronJobProjectionRewrites(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, updated_at, name, enabled, agent_id, payload_kind,
              runtime_updated_at_ms
         FROM cron_jobs
        WHERE payload_kind = 'message'
           OR name = ''`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    updated_at: number | bigint;
    name: unknown;
    enabled: unknown;
    agent_id: unknown;
    payload_kind: unknown;
    runtime_updated_at_ms: unknown;
  }>;
  for (const row of rows) {
    const job = safeParseJsonRecord(row.job_json) ?? null;
    if (!job) {
      continue;
    }
    // Legacy defaults are repaired only in the query-bearing projection; job_json owns config.
    const schedule = asNullableRecord(job.schedule);
    const payload = asNullableRecord(job.payload);
    const scheduleKind = textField(schedule, "kind");
    const payloadKind = textField(payload, "kind");
    const isAt = scheduleKind === "at" && textField(schedule, "at");
    const isEvery = scheduleKind === "every" && asFiniteNumber(schedule?.everyMs) != null;
    const isCron = scheduleKind === "cron" && textField(schedule, "expr");
    const isSystemEvent = payloadKind === "systemEvent" && textField(payload, "text");
    const isAgentTurn = payloadKind === "agentTurn" && textField(payload, "message");
    if (
      !schedule ||
      !payload ||
      !payloadKind ||
      (!isAt && !isEvery && !isCron) ||
      (!isSystemEvent && !isAgentTurn)
    ) {
      continue;
    }
    const projection: CronJobProjection = {
      name: textField(job, "name") ?? row.job_id,
      enabled: job.enabled === false ? 0 : 1,
      agentId: textField(job, "agentId"),
      payloadKind,
      runtimeUpdatedAtMs: asFiniteNumber(job.updatedAtMs) ?? (sqliteNumber(row.updated_at) || 0),
    };
    const unchanged =
      row.name === projection.name &&
      Number(row.enabled) === projection.enabled &&
      row.agent_id === projection.agentId &&
      row.payload_kind === projection.payloadKind &&
      Number(row.runtime_updated_at_ms) === projection.runtimeUpdatedAtMs;
    yield { storeKey: row.store_key, jobId: row.job_id, projection, unchanged };
  }
}

function canBackfillCronJobs(db: DatabaseSync): boolean {
  return (
    tableExists(db, "cron_jobs") &&
    tableHasColumn(db, "cron_jobs", "job_json") &&
    tableHasColumn(db, "cron_jobs", "payload_kind")
  );
}

/** Read-only: whether {@link backfillCronJobsFromJobJson} would change a projection. */
export function hasCronJobProjectionWork(db: DatabaseSync): boolean {
  if (!canBackfillCronJobs(db)) {
    return false;
  }
  for (const rewrite of cronJobProjectionRewrites(db)) {
    if (!rewrite.unchanged) {
      return true;
    }
  }
  return false;
}

export function backfillCronJobsFromJobJson(db: DatabaseSync): void {
  if (!canBackfillCronJobs(db)) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_jobs
        SET name = ?,
            enabled = ?,
            agent_id = ?,
            payload_kind = ?,
            runtime_updated_at_ms = ?
      WHERE store_key = ?
        AND job_id = ?`,
  );
  for (const { storeKey, jobId, projection } of cronJobProjectionRewrites(db)) {
    update.run(
      projection.name,
      projection.enabled,
      projection.agentId,
      projection.payloadKind,
      projection.runtimeUpdatedAtMs,
      storeKey,
      jobId,
    );
  }
}

const DELIVERY_PROJECTION_COLUMNS = [
  ["entry_kind", "entryKind"],
  ["session_key", "sessionKey"],
  ["channel", "channel"],
  ["target", "target"],
  ["account_id", "accountId"],
  ["last_attempt_at", "lastAttemptAt"],
  ["last_error", "lastError"],
  ["recovery_state", "recoveryState"],
  ["platform_send_started_at", "platformSendStartedAt"],
] as const;

/** The denormalized metadata each pending legacy delivery row is rewritten to, in row order. */
function* deliveryQueueProjectionRewrites(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT queue_name, id, entry_json, retry_count,
              ${DELIVERY_PROJECTION_COLUMNS.map(([column]) => column).join(", ")}
         FROM delivery_queue_entries
        WHERE status = 'pending'
          AND (retry_count = 0
            OR last_attempt_at IS NULL
            OR last_error IS NULL
            OR recovery_state IS NULL
            OR platform_send_started_at IS NULL
            OR entry_kind IS NULL
            OR session_key IS NULL
            OR channel IS NULL
            OR target IS NULL
            OR account_id IS NULL)`,
    )
    .all() as Array<
    Record<string, unknown> & { queue_name: string; id: string; entry_json: string }
  >;
  for (const row of rows) {
    const entry = safeParseJsonRecord(row.entry_json) ?? null;
    if (!entry) {
      continue;
    }
    // Queue metadata is denormalized for recovery queries but entry_json remains source of truth.
    const session = asNullableRecord(entry.session);
    const route = asNullableRecord(entry.route);
    const deliveryContext = asNullableRecord(entry.deliveryContext);
    const projection = {
      entryKind: textField(entry, "kind"),
      sessionKey: textField(entry, "sessionKey") ?? textField(session, "key"),
      channel:
        textField(entry, "channel") ??
        textField(route, "channel") ??
        textField(deliveryContext, "channel"),
      target: textField(entry, "to") ?? textField(route, "to") ?? textField(deliveryContext, "to"),
      accountId:
        textField(entry, "accountId") ??
        textField(route, "accountId") ??
        textField(deliveryContext, "accountId"),
      retryCount: asSafeIntegerInRange(entry.retryCount, { min: 0 }) ?? 0,
      lastAttemptAt: asSafeIntegerInRange(entry.lastAttemptAt, { min: 0 }) ?? null,
      lastError: textField(entry, "lastError"),
      recoveryState: textField(entry, "recoveryState"),
      platformSendStartedAt: asSafeIntegerInRange(entry.platformSendStartedAt, { min: 0 }) ?? null,
    };
    // A null projection keeps the stored value (COALESCE); retry_count is always replaced.
    const unchanged =
      Number(row.retry_count) === projection.retryCount &&
      DELIVERY_PROJECTION_COLUMNS.every(([column, key]) => {
        const value = projection[key];
        return (
          value === null ||
          (typeof row[column] === "bigint" ? Number(row[column]) : row[column]) === value
        );
      });
    yield { queueName: row.queue_name, id: row.id, projection, unchanged };
  }
}

function canBackfillDeliveryQueue(db: DatabaseSync): boolean {
  return (
    tableExists(db, "delivery_queue_entries") &&
    tableHasColumn(db, "delivery_queue_entries", "entry_json") &&
    tableHasColumn(db, "delivery_queue_entries", "retry_count")
  );
}

/**
 * Read-only: whether {@link backfillDeliveryQueueEntriesFromEntryJson} would change a row,
 * through its failure compaction, receipt pruning at `now`, or the pending projection.
 */
export function hasDeliveryQueueBackfillWork(db: DatabaseSync, now = Date.now()): boolean {
  if (!canBackfillDeliveryQueue(db)) {
    return false;
  }
  // Compaction rewrites rows the projection then reads, so a pending compaction decides first.
  if (hasLegacyDeliveryQueueFailureCompactionWork(db, now)) {
    return true;
  }
  for (const rewrite of deliveryQueueProjectionRewrites(db)) {
    if (!rewrite.unchanged) {
      return true;
    }
  }
  return false;
}

export function backfillDeliveryQueueEntriesFromEntryJson(db: DatabaseSync): void {
  if (!canBackfillDeliveryQueue(db)) {
    return;
  }
  compactLegacyDeliveryQueueFailures(db);
  const update = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = COALESCE(?, entry_kind),
            session_key = COALESCE(?, session_key),
            channel = COALESCE(?, channel),
            target = COALESCE(?, target),
            account_id = COALESCE(?, account_id),
            retry_count = ?,
            last_attempt_at = COALESCE(?, last_attempt_at),
            last_error = COALESCE(?, last_error),
            recovery_state = COALESCE(?, recovery_state),
            platform_send_started_at = COALESCE(?, platform_send_started_at)
      WHERE queue_name = ?
        AND id = ?`,
  );
  for (const { queueName, id, projection } of deliveryQueueProjectionRewrites(db)) {
    update.run(
      projection.entryKind,
      projection.sessionKey,
      projection.channel,
      projection.target,
      projection.accountId,
      projection.retryCount,
      projection.lastAttemptAt,
      projection.lastError,
      projection.recoveryState,
      projection.platformSendStartedAt,
      queueName,
      id,
    );
  }
}
