import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { resolveAgentCreationClaimAgentId } from "./agent-creation-claim.js";
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

const journalFenceFields = [
  "agent_id",
  "operation_id",
  "agent_dir",
  "workspace_dir",
  "sessions_dir",
  "database_paths_json",
  "cleanup_paths_json",
] as const;
type JournalFenceRow = Pick<
  Selectable<AgentDeletionDatabase["agent_deletion_journal"]>,
  (typeof journalFenceFields)[number] | "cleanup_completed"
>;

type AgentDeletionPathFenceSnapshot = {
  claimAgentId: string;
  claimPath: string;
  fenceAgentId?: string;
  targetPaths: string[];
  journal: "known" | "unknown";
  purpose: AgentDeletionJournalPurpose;
  entries: Array<{
    row: JournalFenceRow;
    fences: Array<{ path: string; canonicalPath: string }>;
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
      .select([...journalFenceFields, "cleanup_completed", "created_at", "delete_files"]);
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
    entries: rows.map(({ databasePaths, cleanupPaths, ...row }) => ({
      row: { ...row, cleanup_completed: row.cleanup_completed === 1 ? 1 : 0 },
      fences: [
        ...[row.agent_dir, row.workspace_dir, row.sessions_dir, ...databasePaths].map(
          (pathname) => ({
            path: pathname,
            canonicalPath: normalizeAgentDirRegistryPath(pathname, env),
          }),
        ),
        ...cleanupPaths.map((cleanupPath) => ({
          path: cleanupPath.path,
          canonicalPath: normalizeAgentDirRegistryPath(cleanupPath.canonicalPath, env),
        })),
      ],
    })),
  };
}

function journalFenceFingerprint(rows: readonly JournalFenceRow[]): string {
  return rows
    .map((row) =>
      [...journalFenceFields.map((field) => row[field]), row.cleanup_completed].join("\0"),
    )
    .toSorted()
    .join("\n");
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
  if (
    journalFenceFingerprint(snapshot.entries.map((entry) => entry.row)) !==
    journalFenceFingerprint(journalRows)
  ) {
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
  // Creation may open the identity it is recreating beneath that identity's completed record.
  const creationAgentId = snapshot.fenceAgentId
    ? undefined
    : resolveAgentCreationClaimAgentId(snapshot.claimAgentId, state.path);
  for (const row of journalRows) {
    if (snapshot.fenceAgentId && snapshot.fenceAgentId !== row.agent_id) {
      continue;
    }
    if (row.agent_id === cleanupAgentId) {
      continue;
    }
    if (row.cleanup_completed === 1 && row.agent_id === creationAgentId) {
      continue;
    }
    assertAgentDeletionIdentityClaimAllowed(snapshot.claimAgentId, row.agent_id);
    if (row.cleanup_completed === 1) {
      continue;
    }
    // Filesystem canonicalization stays outside the SQLite write transaction; the exact journal
    // row is revalidated here so a concurrent deletion can only make the claim fail closed.
    const entry = snapshot.entries.find((candidate) =>
      journalFenceFields.every((field) => candidate.row[field] === row[field]),
    );
    if (!entry) {
      throw new Error("Agent deletion journal changed while preparing a database claim.");
    }
    for (const fence of entry.fences) {
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
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.canonicalPath === "string" &&
        typeof entry.parentPath === "string" &&
        (entry.kind === "target" || entry.kind === "symlink") &&
        (entry.dev === null || typeof entry.dev === "number") &&
        (entry.ino === null || typeof entry.ino === "number") &&
        typeof entry.coversDescendants === "boolean" &&
        typeof entry.done === "boolean" &&
        (entry.note === undefined || typeof entry.note === "string") &&
        Array.isArray(entry.sourcePaths) &&
        entry.sourcePaths.every((sourcePath) => typeof sourcePath === "string"),
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
    const previous = existing && fromRow(existing);
    const databasePaths = [
      ...new Set(
        [
          ...(previous?.databasePaths ?? []),
          ...normalized.databasePaths,
          ...registeredDatabasePaths,
        ].map((entryPath) => path.resolve(entryPath)),
      ),
    ];
    const cleanupPaths = previous?.cleanupPaths ?? normalized.cleanupPaths;
    if (previous) {
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
        ...previous,
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

/** Revoke an attempt while retaining its pending cleanup fence for a later owner. */
export function handoffAgentDeletionJournalInDatabase(
  database: OpenClawStateDatabase,
  agentId: string,
  operationId: string,
  retryOperationId: string,
): boolean {
  assertAgentDeletionJournalAvailable(database.db);
  const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .updateTable("agent_deletion_journal")
      .set({ operation_id: retryOperationId })
      .where("agent_id", "=", normalizeAgentId(agentId))
      .where("operation_id", "=", operationId)
      .where("cleanup_completed", "=", 0),
  );
  const handedOff = result.numAffectedRows === 1n;
  if (handedOff) {
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
  }
  return handedOff;
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
  return runOpenClawStateWriteTransaction((database) => {
    assertAgentDeletionJournalAvailable(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const query = db
      .deleteFrom("agent_deletion_journal")
      .where("agent_id", "=", id)
      .where("operation_id", "=", operationId);
    const result = executeSqliteQuerySync(
      database.db,
      completedOnly ? query.where("cleanup_completed", "=", 1) : query,
    );
    const removed = Number(result.numAffectedRows ?? 0) > 0;
    if (removed) {
      sessionChanges.emit({ all: true, scope: "stores" }, database.db);
    }
    return removed;
  }, options);
}
