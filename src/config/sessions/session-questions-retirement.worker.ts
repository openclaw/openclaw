import { isMainThread } from "node:worker_threads";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

/** Lifecycle owner calls after retiring exactly this generation in its existing transaction. */
export function retireSessionQuestionsInDatabase(
  database: OpenClawAgentDatabase,
  generation: {
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  },
  resolutionId: string,
): string[] {
  if (isMainThread) {
    throw new Error("Durable question retirement requires the owning session worker.");
  }
  if (
    !generation.lifecycleRevision ||
    !getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_questions")
  ) {
    return [];
  }
  const query = getNodeSqliteKysely<Pick<DB, "session_questions">>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    query
      .selectFrom("session_questions")
      .selectAll()
      .where("session_key", "=", generation.sessionKey)
      .where("session_id", "=", generation.sessionId)
      .where("lifecycle_revision", "=", generation.lifecycleRevision)
      .where("continuation_state", "in", ["pending", "owed", "claimed"]),
  ).rows;
  for (const row of rows) {
    executeSqliteQuerySync(
      database.db,
      query
        .updateTable("session_questions")
        .set({
          continuation_state: "interrupted",
          terminal_at: Date.now(),
          continuation_reason:
            "Original session generation was retired; start a new question in the current session.",
          ...(row.result_json === null
            ? {
                result_json: JSON.stringify({ id: row.question_id, status: "cancelled" }),
                resolution_id: resolutionId,
              }
            : {}),
        })
        .where("question_id", "=", row.question_id),
    );
  }
  return rows.map((row) => row.question_id);
}
