import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import type {
  AgentDatabaseDeletionWorkerSnapshot,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.types.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

export function readRetainedAgentDeletionIds(database: EngineConnection): string[] {
  if (!tableExists(database, "agent_deletion_journal")) {
    return [];
  }
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
      .selectFrom("agent_deletion_journal")
      .select("agent_id")
      .where("cleanup_completed", "=", 1)
      .where("delete_files", "=", 0),
  ).rows.map((row) => row.agent_id);
}

/** Capture deletion status and retained-store discovery in the worker's shared read transaction. */
export function readAgentDatabaseDeletionWorkerSnapshot(
  database: EngineConnection,
  statePath: string,
  purpose: AgentDeletionJournalPurpose,
): AgentDatabaseDeletionWorkerSnapshot {
  return runSqliteReadSnapshotSync(
    database,
    () => {
      const deletedAgents: AgentDatabaseDeletionWorkerSnapshot["deletedAgents"] = [];
      return {
        retainedDeletions: readRetainedAgentDeletionsFromDatabase(
          database,
          statePath,
          purpose,
          deletedAgents,
        ),
        registeredAgentDatabases: readRegisteredAgentDatabaseRows(database, statePath, false),
        deletedAgents,
      };
    },
    { operationLabel: "agentDeletionJournal.snapshot" },
  );
}
