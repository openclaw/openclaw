import path from "node:path";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { captureAgentDatabasePreparationDeletionForIdentity } from "../state/agent-database-admission.js";
import {
  type AgentDeletionJournalCleanupPath,
  type AgentDeletionJournalEntry,
  type AgentDeletionJournalInput,
  beginAgentDeletionJournalInDatabase,
  deleteAgentDeletionJournalInDatabase,
  readAgentDeletionJournalInDatabase,
  updateAgentDeletionJournalPathsInDatabase,
} from "../state/agent-deletion-journal.js";
import type { AgentDeletionJournalPurpose } from "../state/agent-deletion-journal.types.js";
import { ensureAgentProvenanceSchema } from "../state/agent-provenance.schema.js";
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";

export function readAgentDeletionJournal(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
  purpose: AgentDeletionJournalPurpose = "maintenance",
): AgentDeletionJournalEntry | undefined {
  return withExistingOpenClawStateDatabaseCurrentReadOnly(
    (database) => readAgentDeletionJournalInDatabase(database, agentId, purpose),
    options,
  );
}

/** Seed a deletion journal while preserving native admission invalidation for fixtures. */
export function beginAgentDeletionJournal(
  entry: AgentDeletionJournalInput,
  options: OpenClawStateDatabaseOptions = {},
): AgentDeletionJournalEntry {
  ensureAgentProvenanceSchema(options);
  return runOpenClawStateWriteTransaction((database) => {
    const invalidatePreparation = captureAgentDatabasePreparationDeletionForIdentity(
      entry.agentId,
      {
        databasePath: database.path,
        identityKey: requireOpenClawStateDatabaseIdentity(database).key,
      },
    );
    if (
      !stageSqliteTransactionState(database.db, {
        stage() {},
        rollback() {},
        commit: invalidatePreparation,
      })
    ) {
      throw new Error("Agent deletion journal requires a managed transaction");
    }
    return beginAgentDeletionJournalInDatabase(database, entry).entry;
  }, options);
}

export function updateAgentDeletionJournalCleanupPaths(
  agentId: string,
  operationId: string,
  cleanupPaths: readonly AgentDeletionJournalCleanupPath[],
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return updateAgentDeletionJournalPaths(
    normalizeAgentId(agentId),
    operationId,
    options,
    "cleanup_paths_json",
    cleanupPaths,
  );
}

export function updateAgentDeletionJournalDatabasePaths(
  agentId: string,
  operationId: string,
  databasePaths: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  const normalizedPaths = [...new Set(databasePaths.map((entryPath) => path.resolve(entryPath)))];
  return updateAgentDeletionJournalPaths(
    id,
    operationId,
    options,
    "database_paths_json",
    normalizedPaths,
  );
}

function updateAgentDeletionJournalPaths(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions,
  ...change:
    | [column: "cleanup_paths_json", paths: readonly AgentDeletionJournalCleanupPath[]]
    | [column: "database_paths_json", paths: readonly string[]]
): boolean {
  return runOpenClawStateWriteTransaction(
    (database) =>
      updateAgentDeletionJournalPathsInDatabase(database, agentId, operationId, ...change),
    options,
  );
}

export function removeAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return deleteAgentDeletionJournal(agentId, operationId, false, options);
}

export function claimCompletedAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return deleteAgentDeletionJournal(agentId, operationId, true, options);
}

function deleteAgentDeletionJournal(
  agentId: string,
  operationId: string,
  completedOnly: boolean,
  options: OpenClawStateDatabaseOptions,
): boolean {
  const id = normalizeAgentId(agentId);
  return runOpenClawStateWriteTransaction(
    (database) => deleteAgentDeletionJournalInDatabase(database, id, operationId, completedOnly),
    options,
  );
}
