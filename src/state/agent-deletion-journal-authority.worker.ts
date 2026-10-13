import type { DatabaseSync } from "node:sqlite";
import { readClawSecondaryReferenceTables } from "../claws/provenance-secondary-references.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { AgentDeletionJournalAuthority } from "./agent-deletion-journal.types.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { ensureAgentDeletionJournalPhaseSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
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

export function hasClawDeletionOwnership(
  database: Pick<OpenClawStateDatabase, "db">,
  agentId: string,
): boolean {
  const db = getNodeSqliteKysely<DB>(database.db);
  return (
    (["claw_installs", "claw_workspace_files"] as const).some(
      (table) =>
        tableExists(database.db, table) &&
        executeSqliteQueryTakeFirstSync(
          database.db,
          db.selectFrom(table).select("agent_id").where("agent_id", "=", agentId).limit(1),
        ) !== undefined,
    ) || readClawSecondaryReferenceTables(database.db, agentId).length > 0
  );
}

export function retireAgentDeletionJournalInDatabase(
  database: OpenClawStateDatabase,
  agentId: string,
  operationId: string,
): boolean {
  ensureAgentDeletionJournalPhaseSchema(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database.db)
      .updateTable("agent_deletion_journal")
      .set({ phase: "retiring" })
      .where("agent_id", "=", normalizeAgentId(agentId))
      .where("operation_id", "=", operationId)
      .where("cleanup_completed", "=", 0),
  );
  const retired = result.numAffectedRows === 1n;
  if (retired) {
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
  }
  return retired;
}
