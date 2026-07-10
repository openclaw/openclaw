/** SQLite persistence and stable cursor queries for metadata-only audit events. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  AuditEventInput,
  AuditEventListFilters,
  AuditEventListPage,
  AuditEventRecord,
} from "./audit-event-types.js";

type AuditEventsTable = OpenClawStateKyselyDatabase["audit_events"];
type AuditDatabase = Pick<OpenClawStateKyselyDatabase, "audit_events">;
type AuditEventRow = Selectable<AuditEventsTable>;

const AUDIT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const AUDIT_EVENT_MAX_ROWS = 100_000;

function getAuditKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AuditDatabase>(db);
}

function rowToAuditEvent(row: AuditEventRow): AuditEventRecord {
  return {
    sequence: normalizeSqliteNumber(row.sequence) ?? 0,
    eventId: row.event_id,
    sourceSequence: normalizeSqliteNumber(row.source_sequence) ?? 0,
    occurredAt: normalizeSqliteNumber(row.occurred_at) ?? 0,
    kind: row.kind as AuditEventRecord["kind"],
    action: row.action as AuditEventRecord["action"],
    status: row.status as AuditEventRecord["status"],
    ...(row.error_code
      ? { errorCode: row.error_code as NonNullable<AuditEventRecord["errorCode"]> }
      : {}),
    actorType: row.actor_type as AuditEventRecord["actorType"],
    actorId: row.actor_id,
    agentId: row.agent_id,
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    runId: row.run_id,
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    redaction: "metadata_only",
  };
}

function bindAuditEvent(input: AuditEventInput): Insertable<AuditEventsTable> {
  return {
    event_id: randomUUID(),
    source_id: `${input.runId}:${input.sourceSequence}:${input.occurredAt}:${input.action}`,
    source_sequence: input.sourceSequence,
    occurred_at: input.occurredAt,
    kind: input.kind,
    action: input.action,
    status: input.status,
    error_code: input.errorCode ?? null,
    actor_type: input.actorType,
    actor_id: input.actorId,
    agent_id: input.agentId,
    session_key: input.sessionKey ?? null,
    session_id: input.sessionId ?? null,
    run_id: input.runId,
    tool_call_id: input.toolCallId ?? null,
    tool_name: input.toolName ?? null,
  };
}

function pruneAuditEventsAfterInsert(db: DatabaseSync, now: number): void {
  const kysely = getAuditKysely(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("audit_events").where("occurred_at", "<", now - AUDIT_EVENT_RETENTION_MS),
  );
  const overflowRow = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_events")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(AUDIT_EVENT_MAX_ROWS)
      .limit(1),
  );
  const sequenceCutoff = overflowRow ? normalizeSqliteNumber(overflowRow.sequence) : undefined;
  if (sequenceCutoff !== undefined) {
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("audit_events").where("sequence", "<=", sequenceCutoff),
    );
  }
}

/** Persist one projected event idempotently and prune fixed retention bounds. */
export function recordAuditEvent(
  input: AuditEventInput,
  options: OpenClawStateDatabaseOptions = {},
): AuditEventRecord | undefined {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const insert = executeSqliteQuerySync(
      db,
      getAuditKysely(db)
        .insertInto("audit_events")
        .values(bindAuditEvent(input))
        .onConflict((conflict) => conflict.column("source_id").doNothing()),
    );
    const insertedSequence = insert.insertId ? Number(insert.insertId) : undefined;
    if (insertedSequence === undefined) {
      return undefined;
    }
    pruneAuditEventsAfterInsert(db, Date.now());
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getAuditKysely(db)
        .selectFrom("audit_events")
        .selectAll()
        .where("sequence", "=", insertedSequence),
    );
    return row ? rowToAuditEvent(row) : undefined;
  }, options);
}

/** List newest-first records using a stable sequence cursor. */
export function listAuditEvents(params: {
  filters?: AuditEventListFilters;
  cursor?: number;
  limit: number;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): AuditEventListPage {
  const { db } = openOpenClawStateDatabase(params.database);
  const filters = params.filters ?? {};
  const retainedAfter = (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS;
  let query = getAuditKysely(db)
    .selectFrom("audit_events")
    .selectAll()
    .where("occurred_at", ">=", retainedAfter);
  if (params.cursor !== undefined) {
    query = query.where("sequence", "<", params.cursor);
  }
  if (filters.agentId) {
    query = query.where("agent_id", "=", filters.agentId);
  }
  if (filters.sessionKey) {
    query = query.where("session_key", "=", filters.sessionKey);
  }
  if (filters.runId) {
    query = query.where("run_id", "=", filters.runId);
  }
  if (filters.kind) {
    query = query.where("kind", "=", filters.kind);
  }
  if (filters.status) {
    query = query.where("status", "=", filters.status);
  }
  if (filters.after !== undefined) {
    query = query.where("occurred_at", ">=", filters.after);
  }
  if (filters.before !== undefined) {
    query = query.where("occurred_at", "<=", filters.before);
  }
  const rows = executeSqliteQuerySync(
    db,
    query.orderBy("sequence", "desc").limit(params.limit + 1),
  ).rows;
  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const events = pageRows.map(rowToAuditEvent);
  return {
    events,
    ...(hasMore && events.length > 0 ? { nextCursor: events[events.length - 1]?.sequence } : {}),
  };
}

/** Delete expired metadata during Gateway startup and periodic worker maintenance. */
export function pruneExpiredAuditEvents(
  params: {
    now?: number;
    database?: OpenClawStateDatabaseOptions;
  } = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getAuditKysely(db)
        .deleteFrom("audit_events")
        .where("occurred_at", "<", (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS),
    );
  }, params.database);
}

export const auditEventStoreLimits = {
  maxRows: AUDIT_EVENT_MAX_ROWS,
  retentionMs: AUDIT_EVENT_RETENTION_MS,
} as const;
