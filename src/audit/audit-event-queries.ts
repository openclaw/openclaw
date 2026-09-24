import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { getNodeSqliteKysely, prepareSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type AuditEventsTable = OpenClawStateKyselyDatabase["audit_events"];
type AuditDatabase = Pick<OpenClawStateKyselyDatabase, "audit_events">;
type AuditEventRow = Selectable<AuditEventsTable>;
export type AuditEventInsert = Required<Omit<Insertable<AuditEventsTable>, "sequence">>;

function createAuditEventQueries(db: DatabaseSync) {
  const database = getNodeSqliteKysely<AuditDatabase>(db);
  return {
    insert: prepareSqliteQueryTakeFirstSync<AuditEventInsert, { sequence: string }>(
      db,
      (parameter) =>
        database
          .insertInto("audit_events")
          .values({
            event_id: parameter((value) => value.event_id),
            source_id: parameter((value) => value.source_id),
            source_sequence: parameter((value) => value.source_sequence),
            schema_version: parameter((value) => value.schema_version),
            occurred_at: parameter((value) => value.occurred_at),
            kind: parameter((value) => value.kind),
            action: parameter((value) => value.action),
            status: parameter((value) => value.status),
            error_code: parameter((value) => value.error_code),
            actor_type: parameter((value) => value.actor_type),
            actor_id: parameter((value) => value.actor_id),
            agent_id: parameter((value) => value.agent_id),
            session_key: parameter((value) => value.session_key),
            session_id: parameter((value) => value.session_id),
            run_id: parameter((value) => value.run_id),
            tool_call_id: parameter((value) => value.tool_call_id),
            tool_name: parameter((value) => value.tool_name),
            direction: parameter((value) => value.direction),
            channel: parameter((value) => value.channel),
            conversation_kind: parameter((value) => value.conversation_kind),
            message_outcome: parameter((value) => value.message_outcome),
            reason_code: parameter((value) => value.reason_code),
            delivery_kind: parameter((value) => value.delivery_kind),
            failure_stage: parameter((value) => value.failure_stage),
            duration_ms: parameter((value) => value.duration_ms),
            result_count: parameter((value) => value.result_count),
            account_ref: parameter((value) => value.account_ref),
            conversation_ref: parameter((value) => value.conversation_ref),
            message_ref: parameter((value) => value.message_ref),
            target_ref: parameter((value) => value.target_ref),
          })
          .onConflict((conflict) => conflict.column("source_id").doNothing())
          .returning((eb) => eb.cast<string>("sequence", "text").as("sequence")),
    ),
    read: prepareSqliteQueryTakeFirstSync<number, AuditEventRow>(db, (parameter) =>
      database
        .selectFrom("audit_events")
        .selectAll()
        .where(
          "sequence",
          "=",
          parameter((sequence) => sequence),
        ),
    ),
  };
}

const auditEventQueries = new WeakMap<DatabaseSync, ReturnType<typeof createAuditEventQueries>>();

export function getAuditEventQueries(db: DatabaseSync) {
  let queries = auditEventQueries.get(db);
  if (!queries) {
    queries = createAuditEventQueries(db);
    auditEventQueries.set(db, queries);
  }
  return queries;
}
