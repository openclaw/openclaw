/** SQLite persistence and stable cursor queries for metadata-only audit events. */
import { randomUUID } from "node:crypto";
import { AUDIT_ACTIVITY_MESSAGE_KIND } from "../../packages/gateway-protocol/src/schema/audit-activity.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getAuditEventQueries, type AuditEventInsert } from "./audit-event-queries.js";
import { parseAgentRunRow, rowToAuditEvent } from "./audit-event-row.js";
import {
  AUDIT_EVENT_SCHEMA_VERSION,
  type AgentRunFinishedAuditEventInput,
  type AgentRunStartedAuditEventInput,
  type AuditEventInput,
  type AuditEventListQuery,
  type AuditEventListPage,
  type AuditEventRecord,
  type MessageAuditEventInput,
} from "./audit-event-types.js";
import {
  clearAuditIdentityKeyCacheForDatabase,
  loadOrCreateAuditIdentityKey,
  pseudonymizeAuditIdentity,
} from "./audit-identity.js";
import {
  ensureTerminalMessageExecutionBindingSchema,
  planMessageExecutionBinding,
  recordConfirmedTerminalMessageExecutionBinding,
} from "./message-execution-binding.js";

type AuditDatabase = Pick<OpenClawStateKyselyDatabase, "audit_events">;

export const AUDIT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const AUDIT_EVENT_MAX_ROWS = 100_000;
const AUDIT_EVENT_PRUNE_BATCH_ROWS = 1_024;
// The single audit writer owns one DB handle. Maintenance and rollback drop
// these facts; ordinary inserts need neither a row scan nor an empty expiry DELETE.
const auditEventRetention = new WeakMap<
  EngineConnection,
  { rowCount: number; nextExpiryAt: number; nextSequence: number }
>();

function projectMessageIdentities(db: EngineConnection, input: MessageAuditEventInput) {
  const identity = loadOrCreateAuditIdentityKey(db);
  const conversationId =
    input.conversationId ?? (input.direction === "outbound" ? input.targetId : undefined);
  const ref = (
    kind: Parameters<typeof pseudonymizeAuditIdentity>[0]["kind"],
    value: string | undefined,
  ) =>
    pseudonymizeAuditIdentity({
      identity,
      kind,
      channel: input.channel,
      ...(kind !== "account" && input.accountId !== undefined
        ? { accountId: input.accountId }
        : {}),
      ...(kind === "message" && conversationId !== undefined ? { conversationId } : {}),
      value,
    });
  return {
    actorId: input.actorType === "channel_sender" ? ref("actor", input.actorId) : input.actorId,
    accountRef: ref("account", input.accountId),
    conversationRef: ref("conversation", conversationId),
    messageRef: ref("message", input.messageId),
    targetRef: ref("target", input.targetId),
  };
}

function bindAuditEvent(db: EngineConnection, input: AuditEventInput, eventId: string) {
  const message =
    input.kind === AUDIT_ACTIVITY_MESSAGE_KIND ? projectMessageIdentities(db, input) : undefined;
  return {
    event_id: eventId,
    source_id: input.sourceId,
    source_sequence: input.sourceSequence,
    schema_version: AUDIT_EVENT_SCHEMA_VERSION,
    occurred_at: input.occurredAt,
    kind: input.kind,
    action: input.action,
    status: input.status,
    error_code: input.errorCode ?? null,
    actor_type: input.actorType,
    actor_id: message?.actorId ?? input.actorId,
    agent_id: input.agentId ?? null,
    session_key: input.kind === AUDIT_ACTIVITY_MESSAGE_KIND ? null : (input.sessionKey ?? null),
    session_id: input.kind === AUDIT_ACTIVITY_MESSAGE_KIND ? null : (input.sessionId ?? null),
    run_id: input.runId ?? null,
    tool_call_id: input.kind === "tool_action" ? (input.toolCallId ?? null) : null,
    tool_name: input.kind === "tool_action" ? input.toolName : null,
    direction: input.kind === AUDIT_ACTIVITY_MESSAGE_KIND ? input.direction : null,
    channel: input.kind === AUDIT_ACTIVITY_MESSAGE_KIND ? input.channel : null,
    conversation_kind: input.kind === "message" ? input.conversationKind : null,
    message_outcome: input.kind === "message" ? input.outcome : null,
    reason_code: input.kind === "message" ? (input.reasonCode ?? null) : null,
    delivery_kind: input.kind === "message" ? (input.deliveryKind ?? null) : null,
    failure_stage: input.kind === "message" ? (input.failureStage ?? null) : null,
    duration_ms: input.kind === "message" ? (input.durationMs ?? null) : null,
    result_count: input.kind === "message" ? (input.resultCount ?? null) : null,
    account_ref: message?.accountRef ?? null,
    conversation_ref: message?.conversationRef ?? null,
    message_ref: message?.messageRef ?? null,
    target_ref: message?.targetRef ?? null,
  } satisfies AuditEventInsert;
}

function readAuditEventRetention(db: EngineConnection) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<AuditDatabase>(db)
      .selectFrom("audit_events")
      .select((expression) => [
        expression.fn.countAll<number>().as("count"),
        expression.fn.min<number>("occurred_at").as("oldest"),
      ]),
  );
  return {
    rowCount: normalizeSqliteNumber(row?.count ?? null) ?? 0,
    nextExpiryAt:
      (normalizeSqliteNumber(row?.oldest ?? null) ?? Number.POSITIVE_INFINITY) +
      AUDIT_EVENT_RETENTION_MS,
  };
}

function deleteExpiredAuditEvents(db: EngineConnection, now: number) {
  const kysely = getNodeSqliteKysely<AuditDatabase>(db);
  const expiredSequences = kysely
    .selectFrom("audit_events")
    .select("sequence")
    .where("occurred_at", "<", now - AUDIT_EVENT_RETENTION_MS)
    .orderBy("occurred_at", "asc")
    .orderBy("sequence", "asc")
    .limit(AUDIT_EVENT_PRUNE_BATCH_ROWS);
  return executeSqliteQuerySync(
    db,
    kysely.deleteFrom("audit_events").where("sequence", "in", expiredSequences),
  );
}

function pruneAfterInsert(
  db: EngineConnection,
  now: number,
  at: number,
  insertedCount: number,
  nextSequence: number,
): void {
  const kysely = getNodeSqliteKysely<AuditDatabase>(db);
  const cached = auditEventRetention.get(db);
  let retention = cached
    ? {
        rowCount: cached.rowCount + insertedCount,
        nextExpiryAt: Math.min(cached.nextExpiryAt, at + AUDIT_EVENT_RETENTION_MS),
      }
    : readAuditEventRetention(db);
  let pruned = false;
  if (retention.nextExpiryAt < now) {
    const expired = deleteExpiredAuditEvents(db, now);
    retention.rowCount = Math.max(0, retention.rowCount - Number(expired.numAffectedRows ?? 0n));
    pruned = true;
  }
  if (retention.rowCount > AUDIT_EVENT_MAX_ROWS) {
    const overflowCutoff = kysely
      .selectFrom("audit_events")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(AUDIT_EVENT_MAX_ROWS - AUDIT_EVENT_PRUNE_BATCH_ROWS)
      .limit(1);
    const overflow = executeSqliteQuerySync(
      db,
      kysely.deleteFrom("audit_events").where("sequence", "<=", overflowCutoff),
    );
    const deleted = Number(overflow.numAffectedRows ?? 0n);
    if (deleted > 0) {
      retention.rowCount = Math.max(0, retention.rowCount - deleted);
      pruned = true;
    } else {
      retention = readAuditEventRetention(db);
      pruned = false;
    }
  }
  if (pruned) {
    const oldest = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("audit_events")
        .select((expression) => expression.fn.min("occurred_at").as("oldest")),
    );
    retention.nextExpiryAt =
      (normalizeSqliteNumber(oldest?.oldest ?? null) ?? Number.POSITIVE_INFINITY) +
      AUDIT_EVENT_RETENTION_MS;
  }
  stageSqliteTransactionState(db, {
    commit: () => {},
    rollback: () => auditEventRetention.delete(db),
    invalidate: () => auditEventRetention.delete(db),
  });
  auditEventRetention.set(db, { ...retention, nextSequence });
}

function getAuditAutocommitRetention(db: EngineConnection, now: number, at: number, count: 1 | 2) {
  const retention = auditEventRetention.get(db);
  return !db.isTransaction &&
    !isPostgresSqlConnection(db) &&
    retention &&
    retention.rowCount + count <= AUDIT_EVENT_MAX_ROWS &&
    retention.nextExpiryAt >= now &&
    at + AUDIT_EVENT_RETENTION_MS >= now &&
    Number.isSafeInteger(retention.nextSequence + (count - 1))
    ? retention
    : undefined;
}

function parseInsertedAuditSequence(value: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("audit event sequence is outside the supported integer range");
  }
  return sequence;
}

/** Persist one projected event idempotently and prune fixed retention bounds. */
export function recordAuditEventInDatabase(
  input: AuditEventInput,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
  eventId: string = randomUUID(),
): AuditEventRecord | undefined {
  const executionToken =
    input.kind === "message" && input.direction === "outbound"
      ? planMessageExecutionBinding(input.executionIdentityToken, input.runId)
      : undefined;
  if (executionToken) {
    ensureTerminalMessageExecutionBindingSchema(options);
  }
  const { db } = options.database;
  try {
    const retention =
      input.kind !== "message"
        ? getAuditAutocommitRetention(db, Date.now(), input.occurredAt, 1)
        : undefined;
    if (retention) {
      const values = bindAuditEvent(db, input, eventId);
      // Validate the complete result before autocommit; even a duplicate
      // source consumes an AUTOINCREMENT sequence.
      const record = rowToAuditEvent({ ...values, sequence: retention.nextSequence });
      const queries = getAuditEventQueries(db);
      const inserted = runOpenClawStateWriteTransaction(() => queries.insert(values), options, {
        singleStatement: true,
      });
      retention.nextSequence += 1;
      if (inserted) {
        retention.rowCount += 1;
        retention.nextExpiryAt = Math.min(
          retention.nextExpiryAt,
          input.occurredAt + AUDIT_EVENT_RETENTION_MS,
        );
      }
      return inserted ? record : undefined;
    }
    return runOpenClawStateWriteTransaction(() => {
      // Read losslessly so Node's rowid decoding cannot preempt the safe-integer guard.
      const values = bindAuditEvent(db, input, eventId);
      const queries = getAuditEventQueries(db);
      const insert = queries.insert(values);
      if (insert === undefined) {
        // Terminal bindings commit with the event, so a replay settles both rows.
        auditEventRetention.delete(db);
        return undefined;
      }
      const insertedSequence = parseInsertedAuditSequence(insert.sequence);
      const now = Date.now();
      pruneAfterInsert(db, now, values.occurred_at, 1, insertedSequence + 1);
      // Current events cannot be removed by retention: sequence allocation puts
      // them after every existing row. An expired replay may be pruned immediately.
      const row =
        values.occurred_at < now - AUDIT_EVENT_RETENTION_MS
          ? queries.read(insertedSequence)
          : { ...values, sequence: insertedSequence };
      recordConfirmedTerminalMessageExecutionBinding(db, {
        eventId: row?.event_id,
        token: executionToken,
      });
      return row ? rowToAuditEvent(row) : undefined;
    }, options);
  } catch (error) {
    auditEventRetention.delete(db);
    clearAuditIdentityKeyCacheForDatabase(db);
    throw error;
  }
}

/** Persist a completed run as one replay-safe insert and one retention pass. */
export function recordAuditRunInDatabase(
  start: AgentRunStartedAuditEventInput,
  finish: AgentRunFinishedAuditEventInput,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
  eventIds: readonly [string, string],
): void {
  const { db } = options.database;
  const values = [
    bindAuditEvent(db, start, eventIds[0]),
    bindAuditEvent(db, finish, eventIds[1]),
  ] as const;
  // Validate both inputs before their atomic INSERT; allocated sequences are checked below.
  for (const value of values) {
    parseAgentRunRow({ ...value, sequence: 1 });
  }
  const queries = getAuditEventQueries(db);
  try {
    const retention = getAuditAutocommitRetention(
      db,
      Date.now(),
      Math.min(start.occurredAt, finish.occurredAt),
      2,
    );
    if (retention) {
      const { rows } = runOpenClawStateWriteTransaction(() => queries.insertRun(values), options, {
        singleStatement: true,
      });
      // SQLite consumes a sequence for every attempt, including replay conflicts.
      retention.nextSequence += 2;
      retention.rowCount += rows.length;
      retention.nextExpiryAt = Math.min(
        retention.nextExpiryAt,
        ...rows.map(
          (row) =>
            values[row.event_id === eventIds[0] ? 0 : 1].occurred_at + AUDIT_EVENT_RETENTION_MS,
        ),
      );
      return;
    }
    return runOpenClawStateWriteTransaction(() => {
      const { rows } = queries.insertRun(values);
      if (rows.length === 0) {
        auditEventRetention.delete(db);
        return;
      }
      // RETURNING order is not a contract; stable event IDs identify each half.
      const inserted = rows.map((row) => ({
        values: row.event_id === eventIds[0] ? values[0] : values[1],
        sequence: parseInsertedAuditSequence(row.sequence),
      }));
      const now = Date.now();
      pruneAfterInsert(
        db,
        now,
        Math.min(...inserted.map((row) => row.values.occurred_at)),
        inserted.length,
        // Both VALUES attempts consume a sequence, including either replay conflict.
        Math.max(...inserted.map((row) => row.sequence + (row.values === values[0] ? 2 : 1))),
      );
    }, options);
  } catch (error) {
    auditEventRetention.delete(db);
    throw error;
  }
}

/** List newest-first records using the shared state worker and a stable sequence cursor. */
export async function listAuditEvents(
  params: Omit<AuditEventListQuery, "now"> & {
    now?: number;
    database?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  },
): Promise<AuditEventListPage> {
  const input: AuditEventListQuery = {
    limit: params.limit,
    now: params.now ?? Date.now(),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    ...(params.filters ? { filters: { ...params.filters } } : {}),
  };
  const context = captureOpenClawStateWorkerContext(params.database);
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return executeOpenClawStateWorker(context, { type: "audit.events.list", input });
}

/** Delete one bounded batch during Gateway startup and periodic audit maintenance. */
export function pruneExpiredAuditEventsInDatabase(params: {
  now?: number;
  database: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase };
}): number {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const deleted = deleteExpiredAuditEvents(db, params.now ?? Date.now());
      auditEventRetention.delete(db);
      return Number(deleted.numAffectedRows ?? 0n);
    },
    params.database,
    { singleStatement: true },
  );
}
