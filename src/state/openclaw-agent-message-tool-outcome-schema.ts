import type { DatabaseSync } from "node:sqlite";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const MESSAGE_TOOL_RUN_OUTCOMES_TABLE = "message_tool_run_outcomes";

/** Lazily installs the additive outcome table on first use. */
export function ensureMessageToolRunOutcomeSchema(
  db: DatabaseSync,
  admit?: (stage: "transaction" | "commit") => void,
): void {
  const facts = getAdmittedSqliteSchemaFacts(db);
  if (
    facts?.tables.has(MESSAGE_TOOL_RUN_OUTCOMES_TABLE) &&
    facts.indexes.has("idx_agent_message_tool_run_outcomes_occurred")
  ) {
    return;
  }
  const install = () => {
    // sqlite-allow-raw -- Canonical additive DDL only.
    db.exec(
      extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, MESSAGE_TOOL_RUN_OUTCOMES_TABLE, {
        endMarker: "CREATE TABLE IF NOT EXISTS session_goal_operations (",
        includeEndMarker: false,
        errorMessage: "OpenClaw message-tool run outcome schema markers are missing.",
      }),
    );
  };
  if (db.isTransaction) {
    install();
    return;
  }
  runSqliteImmediateTransactionSync(
    db,
    () => {
      admit?.("transaction");
      install();
    },
    {
      withCommit(commit) {
        admit?.("commit");
        commit();
      },
    },
  );
}
