import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import type {
  AgentDatabaseDeletionWorkerSnapshot,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.types.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";

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
