import path from "node:path";
import type { Selectable } from "kysely";
import { normalizeAgentDirRegistryPath } from "../agents/agent-dir-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPathInside } from "../infra/path-guards.js";
import { isSqliteCorruptionError } from "../infra/sqlite-error-diagnostics.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { captureAgentDatabasePreparationDeletion } from "./agent-database-admission.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import { resolveAgentDeletionRecoveryHolds } from "./agent-deletion-journal-recovery.js";
import { parseAgentDeletionDatabasePaths } from "./agent-deletion-journal.read.js";
import type { AgentDeletionJournalPurpose } from "./agent-deletion-journal.types.js";
import { deleteAgentProvenanceForAgent, ensureAgentProvenanceSchema } from "./agent-provenance.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "./openclaw-state-db-readonly.js";
import { assertAgentDeletionJournalAvailable } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";

type AgentDeletionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_databases" | "agent_deletion_journal"
>;

type AgentDeletionPathFenceSnapshot = {
  claimAgentId: string;
  claimPath: string;
  fenceAgentId?: string;
  targetPaths: string[];
  journal: "known" | "unknown";
  purpose: AgentDeletionJournalPurpose;
  entries: Array<{
    agentId: string;
    operationId: string;
    agentDir: string;
    workspaceDir: string;
    sessionsDir: string;
    cleanupCompleted: boolean;
    databasePathsJson: string;
    cleanupPathsJson: string;
    canonicalPaths: string[];
    databasePaths: Array<{ path: string; canonicalPath: string }>;
    cleanupPaths: Array<AgentDeletionJournalCleanupPath & { fencePath: string }>;
  }>;
};

export type AgentDeletionJournalCleanupPath = {
  path: string;
  canonicalPath: string;
  parentPath: string;
  kind: "target" | "symlink";
  sourcePaths: string[];
  dev: number | null;
  ino: number | null;
  coversDescendants: boolean;
  done: boolean;
  note?: string;
};

function assertAgentDeletionIdentityClaimAllowed(
  claimAgentId: string,
  deletedAgentId: string | undefined,
): void {
  if (deletedAgentId && normalizeAgentId(claimAgentId) === normalizeAgentId(deletedAgentId)) {
    throw new Error(
      `OpenClaw agent database is unavailable while agent ${normalizeAgentId(deletedAgentId)} is deleted.`,
    );
  }
}

export type AgentDeletionJournalEntry = {
  agentId: string;
  operationId: string;
  agentDir: string;
  workspaceDir: string;
  sessionsDir: string;
  databasePaths: string[];
  cleanupPaths: AgentDeletionJournalCleanupPath[];
  createdAt: number;
  cleanupCompleted: boolean;
  deleteFiles: boolean;
};

function readAgentDeletionPathFenceRows(
  database: OpenClawStateDatabase["db"],
  purpose: AgentDeletionJournalPurpose = "runtime",
  agentId?: string,
) {
  if (purpose === "maintenance") {
    assertAgentDeletionJournalAvailable(database);
  }
  try {
    if (!tableExists(database, "agent_deletion_journal")) {
      return { known: false, rows: [] };
    }
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database);
    let known = true;
    let query = db
      .selectFrom("agent_deletion_journal")
      .select([
        "agent_id",
        "operation_id",
        "agent_dir",
        "workspace_dir",
        "sessions_dir",
        "database_paths_json",
        "cleanup_paths_json",
        "cleanup_completed",
        "created_at",
        "delete_files",
      ]);
    if (agentId !== undefined) {
      query = query.where("agent_id", "=", normalizeAgentId(agentId));
    }
    const rows = executeSqliteQuerySync(database, query).rows.map((row) => {
      let databasePaths: string[] = [];
      let cleanupPaths: AgentDeletionJournalCleanupPath[] = [];
      try {
        databasePaths = parseAgentDeletionDatabasePaths(row.database_paths_json);
        cleanupPaths = parseCleanupPaths(row.cleanup_paths_json);
      } catch (error) {
        if (purpose === "maintenance") {
          throw error;
        }
        known = false;
      }
      return Object.assign(row, { databasePaths, cleanupPaths });
    });
    return { known, rows };
  } catch (error) {
    if (purpose === "maintenance" || isSqliteCorruptionError(error)) {
      throw error;
    }
    // Unknown history is a runtime fact; only Doctor may reconstruct it or hold repairs.
    return { known: false, rows: [] };
  }
}

export function prepareAgentDeletionPathFence(
  claim: { agentId: string; path: string; fenceAgentId?: string },
  options: OpenClawStateDatabaseOptions = {},
  purpose: AgentDeletionJournalPurpose = claim.fenceAgentId ? "maintenance" : "runtime",
): AgentDeletionPathFenceSnapshot {
  const { rows, known } = runOpenClawStateWriteTransaction(
    (database) => readAgentDeletionPathFenceRows(database.db, purpose),
    {
      ...options,
      initializationAgentPaths: [...(options.initializationAgentPaths ?? []), claim.path],
    },
  );
  const env = options.env ?? process.env;
  return {
    journal: known ? "known" : "unknown",
    purpose,
    claimAgentId: normalizeAgentId(claim.agentId),
    claimPath: path.resolve(claim.path),
    ...(claim.fenceAgentId ? { fenceAgentId: normalizeAgentId(claim.fenceAgentId) } : {}),
    // targetPaths is a pre-open realpath snapshot. A co-equal same-user
    // process could retarget a symlink between snapshot and open; that actor
    // already owns every file here, so the fence defends cooperative
    // interleavings only — adversarial local races are out of threat model.
    targetPaths: resolveSqliteDatabaseFilePaths(claim.path).map((filePath) =>
      normalizeAgentDirRegistryPath(filePath, env),
    ),
    entries: rows.map((row) => ({
      agentId: row.agent_id,
      operationId: row.operation_id,
      agentDir: row.agent_dir,
      workspaceDir: row.workspace_dir,
      sessionsDir: row.sessions_dir,
      cleanupCompleted: row.cleanup_completed === 1,
      databasePathsJson: row.database_paths_json,
      cleanupPathsJson: row.cleanup_paths_json,
      canonicalPaths: [row.agent_dir, row.workspace_dir, row.sessions_dir].map((entryPath) =>
        normalizeAgentDirRegistryPath(entryPath, env),
      ),
      databasePaths: row.databasePaths.map((databasePath) => ({
        path: databasePath,
        canonicalPath: normalizeAgentDirRegistryPath(databasePath, env),
      })),
      cleanupPaths: row.cleanupPaths.map((cleanupPath) =>
        Object.assign({}, cleanupPath, {
          fencePath: normalizeAgentDirRegistryPath(cleanupPath.canonicalPath, env),
        }),
      ),
    })),
  };
}

/** Refuse database claims beneath paths still owned by an unfinished deletion. */
export function assertAgentDeletionPathFence(
  state: OpenClawStateDatabase,
  snapshot: AgentDeletionPathFenceSnapshot,
): void {
  const database = state.db;
  const { rows: journalRows, known } = readAgentDeletionPathFenceRows(database, snapshot.purpose);
  if (!known && journalRows.length === 0) {
    return;
  }
  const snapshotJournal = snapshot.entries
    .map((entry) =>
      [
        entry.agentId,
        entry.operationId,
        entry.agentDir,
        entry.workspaceDir,
        entry.sessionsDir,
        entry.databasePathsJson,
        entry.cleanupPathsJson,
        entry.cleanupCompleted ? 1 : 0,
      ].join("\0"),
    )
    .toSorted();
  const currentJournal = journalRows
    .map((row) =>
      [
        row.agent_id,
        row.operation_id,
        row.agent_dir,
        row.workspace_dir,
        row.sessions_dir,
        row.database_paths_json,
        row.cleanup_paths_json,
        row.cleanup_completed,
      ].join("\0"),
    )
    .toSorted();
  if (snapshotJournal.join("\n") !== currentJournal.join("\n")) {
    throw new Error("Agent deletion journal changed while preparing a database claim.");
  }
  // Existing foreign leases remain blockers even inside the deletion's cleanup scope.
  const cleanup = snapshot.fenceAgentId
    ? undefined
    : getAgentDeletionDatabaseCleanup({
        agentId: snapshot.claimAgentId,
        path: snapshot.claimPath,
        statePath: state.path,
      });
  const cleanupAgentId = cleanup?.assertJournal(
    state.path,
    journalRows.map((row) => ({
      agentId: row.agent_id,
      operationId: row.operation_id,
      cleanupCompleted: row.cleanup_completed === 1,
    })),
  );
  for (const row of journalRows) {
    if (snapshot.fenceAgentId && snapshot.fenceAgentId !== row.agent_id) {
      continue;
    }
    if (row.agent_id === cleanupAgentId) {
      continue;
    }
    assertAgentDeletionIdentityClaimAllowed(snapshot.claimAgentId, row.agent_id);
    if (row.cleanup_completed === 1) {
      continue;
    }
    // Filesystem canonicalization stays outside the SQLite write transaction; the exact journal
    // row is revalidated here so a concurrent deletion can only make the claim fail closed.
    const entry = snapshot.entries.find(
      (candidate) =>
        candidate.agentId === row.agent_id &&
        candidate.operationId === row.operation_id &&
        candidate.agentDir === row.agent_dir &&
        candidate.workspaceDir === row.workspace_dir &&
        candidate.sessionsDir === row.sessions_dir &&
        candidate.databasePathsJson === row.database_paths_json &&
        candidate.cleanupPathsJson === row.cleanup_paths_json,
    );
    if (!entry) {
      throw new Error("Agent deletion journal changed while preparing a database claim.");
    }
    const fences = [
      ...entry.canonicalPaths.map((canonicalPath, index) => ({
        canonicalPath,
        path: [entry.agentDir, entry.workspaceDir, entry.sessionsDir][index],
      })),
      ...entry.databasePaths,
      ...entry.cleanupPaths.map((cleanupPath) => ({
        path: cleanupPath.path,
        canonicalPath: cleanupPath.fencePath,
      })),
    ];
    for (const fence of fences) {
      const blockedPath = snapshot.targetPaths.find(
        (targetPath) =>
          targetPath === fence.canonicalPath || isPathInside(fence.canonicalPath, targetPath),
      );
      if (blockedPath) {
        throw new Error(
          `OpenClaw agent database ${blockedPath} is unavailable while agent ${row.agent_id} deletion owns ${fence.path}.`,
        );
      }
    }
  }
}

function fromRow(
  row: Selectable<AgentDeletionDatabase["agent_deletion_journal"]> & {
    databasePaths?: string[];
    cleanupPaths?: AgentDeletionJournalCleanupPath[];
  },
): AgentDeletionJournalEntry {
  return {
    agentId: row.agent_id,
    operationId: row.operation_id,
    agentDir: row.agent_dir,
    workspaceDir: row.workspace_dir,
    sessionsDir: row.sessions_dir,
    databasePaths: row.databasePaths ?? parseAgentDeletionDatabasePaths(row.database_paths_json),
    cleanupPaths: row.cleanupPaths ?? parseCleanupPaths(row.cleanup_paths_json),
    createdAt: row.created_at,
    cleanupCompleted: row.cleanup_completed === 1,
    deleteFiles: row.delete_files === 1,
  };
}

function parseCleanupPaths(value: string): AgentDeletionJournalCleanupPath[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry): entry is AgentDeletionJournalCleanupPath =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { canonicalPath?: unknown }).canonicalPath === "string" &&
        typeof (entry as { parentPath?: unknown }).parentPath === "string" &&
        ((entry as { kind?: unknown }).kind === "target" ||
          (entry as { kind?: unknown }).kind === "symlink") &&
        ((entry as { dev?: unknown }).dev === null ||
          typeof (entry as { dev?: unknown }).dev === "number") &&
        ((entry as { ino?: unknown }).ino === null ||
          typeof (entry as { ino?: unknown }).ino === "number") &&
        typeof (entry as { coversDescendants?: unknown }).coversDescendants === "boolean" &&
        typeof (entry as { done?: unknown }).done === "boolean" &&
        ((entry as { note?: unknown }).note === undefined ||
          typeof (entry as { note?: unknown }).note === "string") &&
        Array.isArray((entry as { sourcePaths?: unknown }).sourcePaths) &&
        (entry as { sourcePaths: unknown[] }).sourcePaths.every(
          (sourcePath) => typeof sourcePath === "string",
        ),
    )
  ) {
    throw new Error("Invalid agent deletion cleanup path journal.");
  }
  return parsed;
}

/** Read the journal through an already validated shared-state connection. */
export function readAgentDeletionJournalInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  agentId: string,
  purpose: AgentDeletionJournalPurpose = "maintenance",
): AgentDeletionJournalEntry | undefined {
  const row = readAgentDeletionPathFenceRows(database.db, purpose, agentId).rows[0];
  return row ? fromRow(row) : undefined;
}

export function readAgentDeletionJournal(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
  purpose: AgentDeletionJournalPurpose = "maintenance",
): AgentDeletionJournalEntry | undefined {
  // Worker commit guards must read current authority without joining the worker's writer lock.
  return withExistingOpenClawStateDatabaseCurrentReadOnly(
    (database) => readAgentDeletionJournalInDatabase(database, agentId, purpose),
    options,
  );
}

export function beginAgentDeletionJournal(
  entry: Omit<
    AgentDeletionJournalEntry,
    "createdAt" | "cleanupCompleted" | "databasePaths" | "cleanupPaths"
  > & {
    databasePaths?: string[];
    cleanupPaths?: AgentDeletionJournalCleanupPath[];
  },
  options: OpenClawStateDatabaseOptions = {},
): AgentDeletionJournalEntry {
  const normalized = {
    ...entry,
    agentId: normalizeAgentId(entry.agentId),
    databasePaths: [
      ...new Set((entry.databasePaths ?? []).map((entryPath) => path.resolve(entryPath))),
    ],
    cleanupPaths: entry.cleanupPaths ?? [],
  };
  ensureAgentProvenanceSchema(options);
  return runOpenClawStateWriteTransaction((database) => {
    const invalidatePreparation = captureAgentDatabasePreparationDeletion(
      normalized.agentId,
      database,
    );
    // State publication precedes observers and waits for the outermost successful commit.
    if (
      !stageSqliteTransactionState(database.db, {
        stage() {},
        rollback() {},
        commit: invalidatePreparation,
      })
    ) {
      throw new Error("Agent deletion journal requires a managed transaction");
    }
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    assertAgentDeletionJournalAvailable(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const existing = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("agent_deletion_journal")
        .selectAll()
        .where("agent_id", "=", normalized.agentId),
    );
    const registeredDatabasePaths = executeSqliteQuerySync(
      database.db,
      db.selectFrom("agent_databases").select("path").where("agent_id", "=", normalized.agentId),
    ).rows.flatMap((row) =>
      resolveSqliteDatabaseFilePaths(
        resolveOpenClawRegisteredAgentDatabasePath(database.path, row.path),
      ),
    );
    const databasePaths = [
      ...new Set(
        [
          ...(existing ? fromRow(existing).databasePaths : []),
          ...normalized.databasePaths,
          ...registeredDatabasePaths,
        ].map((entryPath) => path.resolve(entryPath)),
      ),
    ];
    const cleanupPaths = existing ? fromRow(existing).cleanupPaths : normalized.cleanupPaths;
    if (existing) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("agent_deletion_journal")
          .set({
            operation_id: normalized.operationId,
            database_paths_json: JSON.stringify(databasePaths),
            cleanup_paths_json: JSON.stringify(cleanupPaths),
            cleanup_completed: 0,
            delete_files: normalized.deleteFiles ? 1 : 0,
          })
          .where("agent_id", "=", normalized.agentId),
      );
      return {
        ...fromRow(existing),
        operationId: normalized.operationId,
        databasePaths,
        cleanupPaths,
        cleanupCompleted: false,
        deleteFiles: normalized.deleteFiles,
      };
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
        database_paths_json: JSON.stringify(databasePaths),
        cleanup_paths_json: JSON.stringify(cleanupPaths),
        created_at: createdAt,
        cleanup_completed: 0,
        delete_files: normalized.deleteFiles ? 1 : 0,
      }),
    );
    return { ...normalized, databasePaths, cleanupPaths, createdAt, cleanupCompleted: false };
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
    "cleanup_paths_json",
    cleanupPaths,
    options,
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
    "database_paths_json",
    normalizedPaths,
    options,
  );
}

function updateAgentDeletionJournalPaths(
  agentId: string,
  operationId: string,
  column: "cleanup_paths_json" | "database_paths_json",
  paths: readonly AgentDeletionJournalCleanupPath[] | readonly string[],
  options: OpenClawStateDatabaseOptions,
): boolean {
  return runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionJournalAvailable(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("agent_deletion_journal")
        .set({ [column]: JSON.stringify(paths) })
        .where("agent_id", "=", agentId)
        .where("operation_id", "=", operationId)
        .where("cleanup_completed", "=", 0),
    );
    const updated = Number(result.numAffectedRows ?? 0) > 0;
    if (updated) {
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    }
    return updated;
  }, options);
}

/** Complete a deletion journal inside a caller-owned shared-state transaction. */
export function completeAgentDeletionJournalInDatabase(
  database: OpenClawStateDatabase,
  agentId: string,
  operationId: string,
): boolean {
  const id = normalizeAgentId(agentId);
  assertAgentDeletionJournalAvailable(database.db);
  const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .updateTable("agent_deletion_journal")
      .set({ cleanup_completed: 1 })
      .where("agent_id", "=", id)
      .where("operation_id", "=", operationId),
  );
  const completed = Number(result.numAffectedRows ?? 0) > 0;
  // The journal already fences authority. Keep creation history through refusals and
  // partial cleanup, and remove it only when this exact deletion owner completes.
  if (completed) {
    const journal = readAgentDeletionJournalInDatabase(database, id);
    resolveAgentDeletionRecoveryHolds(database, id, journal?.databasePaths ?? []);
    deleteAgentProvenanceForAgent(database.db, id);
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
  }
  return completed;
}

export function removeAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  return runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionJournalAvailable(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("agent_deletion_journal")
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId),
    );
    const removed = Number(result.numAffectedRows ?? 0) > 0;
    if (removed) {
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    }
    return removed;
  }, options);
}

export function claimCompletedAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  return runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionJournalAvailable(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("agent_deletion_journal")
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId)
        .where("cleanup_completed", "=", 1),
    );
    const removed = Number(result.numAffectedRows ?? 0) > 0;
    if (removed) {
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    }
    return removed;
  }, options);
}
