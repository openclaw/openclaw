import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import type {
  AgentDatabaseDeletionWorkerSnapshot,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.types.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** Capture deletion status and retained-store discovery in the worker's shared read transaction. */
export function readAgentDatabaseDeletionWorkerSnapshot(
  database: DatabaseSync,
  statePath: string,
  purpose: AgentDeletionJournalPurpose,
): AgentDatabaseDeletionWorkerSnapshot {
  return runSqliteDeferredTransactionSync(
    database,
    () => ({
      retainedDeletions: readRetainedAgentDeletionsFromDatabase(database, statePath, purpose),
      registeredAgentDatabases: readRegisteredAgentDatabaseRows(database, statePath, false),
      deletedAgents: tableExists(database, "agent_deletion_journal")
        ? executeSqliteQuerySync(
            database,
            getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
              .selectFrom("agent_deletion_journal")
              .select(["agent_id", "cleanup_completed"]),
          ).rows.map((row) => ({
            agentId: row.agent_id,
            status: row.cleanup_completed === 1 ? ("complete" as const) : ("pending" as const),
          }))
        : [],
    }),
    { operationLabel: "agentDeletionJournal.snapshot" },
  );
}
