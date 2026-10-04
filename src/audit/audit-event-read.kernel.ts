import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { AUDIT_EVENT_RETENTION_MS, rowToAuditEvent } from "./audit-event-store.js";
import { listSkillSelectionAuditEvents } from "./audit-event-store.skill-selection-storage.js";
import type {
  AuditEventListQuery,
  AuditEventListPage,
  AuditEventRecord,
} from "./audit-event-types.js";

/** Connection-bound query kernel; production list reads execute only in the state worker. */
export function listAuditEventsInDatabase(
  db: DatabaseSync,
  params: AuditEventListQuery,
): AuditEventListPage {
  const filters = params.filters ?? {};
  const retainedAfter = params.now - AUDIT_EVENT_RETENTION_MS;
  const includeSkillSelections =
    filters.includeSkillSelections === true || filters.kind === "skill_selection";
  let auditEvents: AuditEventRecord[] = [];
  if (filters.kind !== "skill_selection") {
    let query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "audit_events">>(db)
      .selectFrom("audit_events")
      .selectAll()
      .where("occurred_at", ">=", retainedAfter)
      .where("kind", "!=", "skill_selection")
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
    auditEvents = rows.map(rowToAuditEvent);
  }
  const skillEvents = includeSkillSelections
    ? listSkillSelectionAuditEvents({
        db,
        filters,
        retainedAfter,
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        limit: params.limit + 1,
      })
    : [];
  const mergedEvents = [...auditEvents, ...skillEvents].toSorted((left, right) => {
    if (right.sequence !== left.sequence) {
      return right.sequence - left.sequence;
    }
    return right.occurredAt - left.occurredAt;
  });
  const hasMore = mergedEvents.length > params.limit;
  const events: AuditEventRecord[] = hasMore ? mergedEvents.slice(0, params.limit) : mergedEvents;
  return {
    events,
    ...(hasMore && events.length > 0 ? { nextCursor: events[events.length - 1]?.sequence } : {}),
  };
}
