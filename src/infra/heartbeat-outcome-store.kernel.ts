import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type HeartbeatDatabase = Pick<OpenClawAgentKyselyDatabase, "heartbeat_outcomes" | "session_nodes">;
export type HeartbeatOutcomeInput = Insertable<OpenClawAgentKyselyDatabase["heartbeat_outcomes"]>;
export type HeartbeatOutcomeRow = Selectable<OpenClawAgentKyselyDatabase["heartbeat_outcomes"]>;

/** The caller owns the synchronous transaction and its current admission. */
export function persistHeartbeatOutcomeInDatabase(
  db: DatabaseSync,
  values: HeartbeatOutcomeInput,
): undefined {
  const agentDb = getNodeSqliteKysely<HeartbeatDatabase>(db);
  const { session_key: _sessionKey, ...replacement } = values;
  executeSqliteQuerySync(
    db,
    agentDb
      .insertInto("heartbeat_outcomes")
      .columns([
        "session_key",
        "run_session_key",
        "outcome",
        "summary",
        "response_reason",
        "priority",
        "next_check",
        "task_names_json",
        "wake_source",
        "wake_reason",
        "occurred_at",
        "context_run_id",
        "context_claimed_at",
        "updated_at",
      ])
      // Transient isolated runs can have no base row for a later user turn.
      .expression(
        agentDb
          .selectFrom("session_nodes")
          .select((eb) => [
            "session_key",
            eb.val(values.run_session_key).as("run_session_key"),
            eb.val(values.outcome).as("outcome"),
            eb.val(values.summary).as("summary"),
            eb.val(values.response_reason).as("response_reason"),
            eb.val(values.priority).as("priority"),
            eb.val(values.next_check).as("next_check"),
            eb.val(values.task_names_json).as("task_names_json"),
            eb.val(values.wake_source).as("wake_source"),
            eb.val(values.wake_reason).as("wake_reason"),
            eb.val(values.occurred_at).as("occurred_at"),
            eb.val(values.context_run_id).as("context_run_id"),
            eb.val(values.context_claimed_at).as("context_claimed_at"),
            eb.val(values.updated_at).as("updated_at"),
          ])
          .where("session_key", "=", values.session_key),
      )
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          ...replacement,
          context_run_id: null,
          context_claimed_at: null,
        }),
      ),
  );
}

export function claimHeartbeatOutcomeRowInDatabase(
  db: DatabaseSync,
  params: { sessionKey: string; runId: string },
): HeartbeatOutcomeRow | undefined {
  const agentDb = getNodeSqliteKysely<HeartbeatDatabase>(db);
  return executeSqliteQuerySync(
    db,
    agentDb
      .updateTable("heartbeat_outcomes")
      .set((eb) => ({
        context_run_id: params.runId,
        context_claimed_at: eb.fn.coalesce("context_claimed_at", eb.val(Date.now())),
      }))
      .where("session_key", "=", params.sessionKey)
      .where((eb) =>
        eb.or([eb("context_run_id", "is", null), eb("context_run_id", "=", params.runId)]),
      )
      .returningAll(),
  ).rows[0];
}
