import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type AgentDeletionDatabase = Pick<OpenClawStateKyselyDatabase, "agent_deletion_journal">;

export type AgentDeletionJournalEntry = {
  agentId: string;
  operationId: string;
  agentDir: string;
  workspaceDir: string;
  sessionsDir: string;
  createdAt: number;
  cleanupCompleted: boolean;
  deleteFiles: boolean;
};

export function ensureAgentDeletionJournalSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_deletion_journal (
      agent_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL DEFAULT '',
      agent_dir TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      sessions_dir TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cleanup_completed INTEGER NOT NULL DEFAULT 0,
      delete_files INTEGER NOT NULL DEFAULT 1
    ) STRICT
  `);
}

function fromRow(row: {
  agent_id: string;
  operation_id: string;
  agent_dir: string;
  workspace_dir: string;
  sessions_dir: string;
  created_at: number;
  cleanup_completed: number;
  delete_files: number;
}): AgentDeletionJournalEntry {
  return {
    agentId: row.agent_id,
    operationId: row.operation_id,
    agentDir: row.agent_dir,
    workspaceDir: row.workspace_dir,
    sessionsDir: row.sessions_dir,
    createdAt: row.created_at,
    cleanupCompleted: row.cleanup_completed === 1,
    deleteFiles: row.delete_files === 1,
  };
}

export function readAgentDeletionJournal(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentDeletionJournalEntry | undefined {
  const id = normalizeAgentId(agentId);
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!existsSync(databasePath)) {
    return undefined;
  }
  let entry: AgentDeletionJournalEntry | undefined;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("agent_deletion_journal").selectAll().where("agent_id", "=", id),
    );
    entry = row ? fromRow(row) : undefined;
  }, options);
  return entry;
}

export function beginAgentDeletionJournal(
  entry: Omit<AgentDeletionJournalEntry, "createdAt" | "cleanupCompleted">,
  options: OpenClawStateDatabaseOptions = {},
): AgentDeletionJournalEntry {
  const normalized = { ...entry, agentId: normalizeAgentId(entry.agentId) };
  let persisted: AgentDeletionJournalEntry | undefined;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const existing = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("agent_deletion_journal")
        .selectAll()
        .where("agent_id", "=", normalized.agentId),
    );
    if (existing) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("agent_deletion_journal")
          .set({
            operation_id: normalized.operationId,
            cleanup_completed: 0,
            delete_files: normalized.deleteFiles ? 1 : 0,
          })
          .where("agent_id", "=", normalized.agentId),
      );
      persisted = {
        ...fromRow(existing),
        operationId: normalized.operationId,
        cleanupCompleted: false,
        deleteFiles: normalized.deleteFiles,
      };
      return;
    }
    const createdAt = Date.now();
    executeSqliteQuerySync(
      database.db,
      db.insertInto("agent_deletion_journal").values({
        agent_id: normalized.agentId,
        operation_id: normalized.operationId,
        agent_dir: normalized.agentDir,
        workspace_dir: normalized.workspaceDir,
        sessions_dir: normalized.sessionsDir,
        created_at: createdAt,
        cleanup_completed: 0,
        delete_files: normalized.deleteFiles ? 1 : 0,
      }),
    );
    persisted = { ...normalized, createdAt, cleanupCompleted: false };
  }, options);
  if (!persisted) {
    throw new Error(`Failed to record deletion journal for agent ${normalized.agentId}.`);
  }
  return persisted;
}

export function completeAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  let completed = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("agent_deletion_journal")
        .set({ cleanup_completed: 1 })
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId),
    );
    completed = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return completed;
}

export function removeAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  let removed = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("agent_deletion_journal")
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId),
    );
    removed = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return removed;
}

export function claimCompletedAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  let removed = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("agent_deletion_journal")
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId)
        .where("cleanup_completed", "=", 1),
    );
    removed = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return removed;
}
