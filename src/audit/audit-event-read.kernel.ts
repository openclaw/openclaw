import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { AUDIT_EVENT_RETENTION_MS, rowToAuditEvent } from "./audit-event-store.js";
import type { AuditEventListQuery, AuditEventListPage } from "./audit-event-types.js";

/** Connection-bound query kernel; production list reads execute only in the state worker. */
export function listAuditEventsInDatabase(
  db: DatabaseSync,
  params: AuditEventListQuery,
): AuditEventListPage {
  const filters = params.filters ?? {};
  const retainedAfter = params.now - AUDIT_EVENT_RETENTION_MS;
  let query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "audit_events">>(db)
    .selectFrom("audit_events")
    .selectAll()
    .where("occurred_at", ">=", retainedAfter)
    // Nonterminal outbound facts belong to the lazy progress owner. Excluding
    // transitional rows keeps the released activity contract terminal-only.
    .where("action", "not in", ["message.outbound.queued", "message.outbound.platform-started"]);
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
  } else if (filters.includeMessages !== true) {
    query = query.where("kind", "!=", "message");
  }
  if (filters.status) {
    query = query.where("status", "=", filters.status);
  }
  if (filters.direction) {
    query = query.where("direction", "=", filters.direction);
  }
  if (filters.channel) {
    query = query.where("channel", "=", filters.channel);
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
