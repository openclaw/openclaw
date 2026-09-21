import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  readAgentDeletionRecoveryHolds,
  type HeldAgentDatabase,
} from "./agent-deletion-journal-recovery.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

type RetainedAgentDeletion = { agentId: string; agentDir: string; databasePaths: string[] };
export type AgentDeletionJournalDisposition =
  | { status: "unavailable"; reason: string }
  | { status: "empty" }
  | { status: "present"; entries: RetainedAgentDeletion[]; held: HeldAgentDatabase[] };

export function parseAgentDeletionDatabasePaths(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    Array.isArray(parsed) &&
    parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    return parsed;
  }
  throw new Error("Invalid agent deletion database path journal.");
}

/** Read existing deletion history without initializing or repairing the journal. */
export function readRetainedAgentDeletionsFromDatabase(
  database: DatabaseSync,
  statePath: string,
): AgentDeletionJournalDisposition {
  if (!tableExists(database, "agent_deletion_journal")) {
    return { status: "unavailable", reason: "deletion journal missing" };
  }
  const entries = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
      .selectFrom("agent_deletion_journal")
      .select(["agent_id", "agent_dir", "database_paths_json"])
      .where("cleanup_completed", "=", 1)
      .where("delete_files", "=", 0)
      .orderBy("agent_id", "asc"),
  ).rows.map((row) => ({
    agentId: row.agent_id,
    agentDir: row.agent_dir,
    databasePaths: [
      path.join(row.agent_dir, "openclaw-agent.sqlite"),
      ...parseAgentDeletionDatabasePaths(row.database_paths_json),
    ],
  }));
  const held = readAgentDeletionRecoveryHolds({ db: database, path: statePath });
  return entries.length || held.length ? { status: "present", entries, held } : { status: "empty" };
}

/** Read journal and registered-owner facts from one shared-state generation. */
export function readAgentDatabaseDeletionSnapshot(env: NodeJS.ProcessEnv) {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db, path: statePath }) =>
      runSqliteDeferredTransactionSync(db, () => ({
        retainedDeletions: readRetainedAgentDeletionsFromDatabase(db, statePath),
        registeredAgentDatabases: readRegisteredAgentDatabaseRows(db, statePath, false),
      })),
    { env },
  );
}
