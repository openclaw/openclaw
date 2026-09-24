import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type HeartbeatDatabase = Pick<OpenClawAgentKyselyDatabase, "heartbeat_outcomes" | "session_nodes">;
export type HeartbeatOutcomeInput = Insertable<OpenClawAgentKyselyDatabase["heartbeat_outcomes"]>;
export type HeartbeatOutcomeRow = Selectable<OpenClawAgentKyselyDatabase["heartbeat_outcomes"]>;

/** The caller owns the synchronous transaction and its current admission. */
export function persistHeartbeatOutcomeInDatabase(
  db: DatabaseSync,
  values: HeartbeatOutcomeInput,
): undefined {
  const agentDb = getNodeSqliteKysely<HeartbeatDatabase>(db);
  const owner = executeSqliteQueryTakeFirstSync(
    db,
    agentDb
      .selectFrom("session_nodes")
      .select("session_key")
      .where("session_key", "=", values.session_key),
  );
  // Transient isolated runs can have no durable base row for a later user turn.
  if (!owner) {
    return;
  }
  executeSqliteQuerySync(
    db,
    agentDb
      .insertInto("heartbeat_outcomes")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          run_session_key: values.run_session_key,
          outcome: values.outcome,
          summary: values.summary,
          response_reason: values.response_reason,
          priority: values.priority,
          next_check: values.next_check,
          task_names_json: values.task_names_json,
          wake_source: values.wake_source,
          wake_reason: values.wake_reason,
          occurred_at: values.occurred_at,
          context_run_id: null,
          context_claimed_at: null,
          updated_at: values.updated_at,
        }),
      ),
  );
}

export function claimHeartbeatOutcomeRowInDatabase(
  db: DatabaseSync,
  params: { sessionKey: string; runId: string },
): HeartbeatOutcomeRow | undefined {
  const agentDb = getNodeSqliteKysely<HeartbeatDatabase>(db);
  const row = executeSqliteQuerySync(
    db,
    agentDb
      .selectFrom("heartbeat_outcomes")
      .selectAll()
      .where("session_key", "=", params.sessionKey),
  ).rows[0];
  if (!row || (row.context_run_id !== null && row.context_run_id !== params.runId)) {
    return undefined;
  }
  if (row.context_run_id === null) {
    const claim = executeSqliteQuerySync(
      db,
      agentDb
        .updateTable("heartbeat_outcomes")
        .set({ context_run_id: params.runId, context_claimed_at: Date.now() })
        .where("session_key", "=", params.sessionKey)
        .where("context_run_id", "is", null),
    );
    if (claim.numAffectedRows !== 1n) {
      return undefined;
    }
  }
  return row;
}
