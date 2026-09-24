import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  readAgentDeletionRecoveryHolds,
  type HeldAgentDatabase,
} from "./agent-deletion-journal-recovery.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

export type AgentDeletionJournalPurpose = "runtime" | "maintenance";

type RetainedAgentDeletion = { agentId: string; agentDir: string; databasePaths: string[] };
type KnownAgentDeletionFacts = {
  entries: RetainedAgentDeletion[];
  held: HeldAgentDatabase[];
};
export type AgentDeletionJournalDisposition =
  | {
      status: "unavailable";
      cause: "missing" | "unreadable";
      reason: string;
      known?: KnownAgentDeletionFacts;
    }
  | { status: "empty" }
  | ({ status: "present" } & KnownAgentDeletionFacts);

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
  purpose: AgentDeletionJournalPurpose = "maintenance",
): AgentDeletionJournalDisposition {
  let entries: RetainedAgentDeletion[] = [];
  let missing = false;
  let unreadableReason: string | undefined;
  try {
    missing = !tableExists(database, "agent_deletion_journal");
    if (!missing) {
      entries = executeSqliteQuerySync(
        database,
        getNodeSqliteKysely<Pick<DB, "agent_deletion_journal">>(database)
          .selectFrom("agent_deletion_journal")
          .select(["agent_id", "agent_dir", "database_paths_json"])
          .where("cleanup_completed", "=", 1)
          .where("delete_files", "=", 0)
          .orderBy("agent_id", "asc"),
      ).rows.map((row) => {
        let databasePaths: string[] = [];
        try {
          databasePaths = parseAgentDeletionDatabasePaths(row.database_paths_json);
        } catch (error) {
          if (purpose === "maintenance") {
            unreadableReason ??= formatErrorMessage(error);
          }
          // Unreadable path details cannot erase this row's known deleted identity.
        }
        return {
          agentId: row.agent_id,
          agentDir: row.agent_dir,
          databasePaths: [path.join(row.agent_dir, "openclaw-agent.sqlite"), ...databasePaths],
        };
      });
    }
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      throw error;
    }
    unreadableReason = formatErrorMessage(error);
  }
  const held =
    purpose === "maintenance" && tableExists(database, "migration_sources")
      ? readAgentDeletionRecoveryHolds({ db: database, path: statePath })
      : [];
  if (missing || unreadableReason !== undefined) {
    return {
      status: "unavailable",
      cause: missing ? "missing" : "unreadable",
      reason: missing
        ? "deletion journal missing"
        : `deletion journal unreadable: ${unreadableReason}`,
      ...(entries.length || held.length ? { known: { entries, held } } : {}),
    };
  }
  return entries.length || held.length ? { status: "present", entries, held } : { status: "empty" };
}

/** Read journal and registered-owner facts from one shared-state generation. */
export function readAgentDatabaseDeletionSnapshot(
  env: NodeJS.ProcessEnv,
  purpose: AgentDeletionJournalPurpose = "maintenance",
) {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db, path: statePath }) =>
      runSqliteDeferredTransactionSync(db, () => ({
        retainedDeletions: readRetainedAgentDeletionsFromDatabase(db, statePath, purpose),
        registeredAgentDatabases: readRegisteredAgentDatabaseRows(db, statePath, false),
      })),
    { env },
  );
}
