import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const MESSAGE_TOOL_RUN_OUTCOME_MAX_ROWS = 10_000;
type MessageToolRunOutcomeDatabase = Pick<OpenClawAgentKyselyDatabase, "message_tool_run_outcomes">;
export type MessageToolRunOutcomeInsert = Insertable<
  OpenClawAgentKyselyDatabase["message_tool_run_outcomes"]
>;

/** Shared by the durable worker and the process-held incognito owner. */
export function recordMessageToolRunOutcomeInDatabase(
  db: DatabaseSync,
  values: MessageToolRunOutcomeInsert,
): void {
  const agentDb = getNodeSqliteKysely<MessageToolRunOutcomeDatabase>(db);
  executeSqliteQuerySync(db, agentDb.insertInto("message_tool_run_outcomes").values(values));
  executeSqliteQuerySync(
    db,
    agentDb
      .deleteFrom("message_tool_run_outcomes")
      .where(
        "id",
        "in",
        agentDb
          .selectFrom("message_tool_run_outcomes")
          .select("id")
          .orderBy("occurred_at", "desc")
          .orderBy("id", "desc")
          .limit(2_147_483_647)
          .offset(MESSAGE_TOOL_RUN_OUTCOME_MAX_ROWS),
      ),
  );
}
