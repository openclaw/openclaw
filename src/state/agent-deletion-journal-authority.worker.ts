import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AgentDeletionJournalAuthority } from "./agent-deletion-journal.types.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** Deletion authority requires its admitted journal; unavailable rows must never grant cleanup. */
export function readAgentDeletionJournalAuthorityInDatabase(
  database: DatabaseSync,
  agentId: string,
): AgentDeletionJournalAuthority | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
      .selectFrom("agent_deletion_journal")
      .select(["agent_id", "operation_id", "cleanup_completed"])
      .where("agent_id", "=", normalizeAgentId(agentId)),
  );
  if (!row) {
    return undefined;
  }
  if (
    typeof row.operation_id !== "string" ||
    !row.operation_id ||
    (row.cleanup_completed !== 0 && row.cleanup_completed !== 1)
  ) {
    throw new Error("Agent deletion journal authority is unreadable.");
  }
  return {
    agentId: row.agent_id,
    operationId: row.operation_id,
    cleanupCompleted: row.cleanup_completed === 1,
  };
}
