import path from "node:path";
import { isMainThread } from "node:worker_threads";
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
import { normalizeAgentId } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveAgentCreationClaimAgentId } from "./agent-creation-claim.js";
import { getAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import { hasClawDeletionOwnership } from "./agent-deletion-journal-authority.worker.js";
import {
  agentDeletionJournalPublication,
  observeAgentDeletionJournal,
} from "./agent-deletion-journal-publication.js";
import { resolveAgentDeletionRecoveryHolds } from "./agent-deletion-journal-recovery.js";
import { parseAgentDeletionDatabasePaths } from "./agent-deletion-journal.read.js";
import type {
  AgentDeletionJournalCleanupPath,
  AgentDeletionJournalEntry,
  AgentDeletionJournalInput,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.types.js";
import { deleteAgentProvenanceForAgent } from "./agent-provenance.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "./openclaw-state-db-readonly.js";
import {
  assertAgentDeletionJournalAvailable,
  ensureAgentDeletionJournalPhaseSchema,
} from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export type {
  AgentDeletionJournalCleanupPath,
  AgentDeletionJournalEntry,
  AgentDeletionJournalInput,
} from "./agent-deletion-journal.types.js";

type AgentDeletionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_databases" | "agent_deletion_journal"
>;

const journalFenceFields = [
  "agent_id",
  "operation_id",
  "phase",
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

/** Deletion ownership refusal is distinct from an unhealthy native database. */
export class AgentDatabaseDeletionRefusedError extends Error {}

function assertAgentDeletionIdentityClaimAllowed(
  claimAgentId: string,
  deletedAgentId: string | undefined,
): void {
  if (deletedAgentId && normalizeAgentId(claimAgentId) === normalizeAgentId(deletedAgentId)) {
    throw new AgentDatabaseDeletionRefusedError(
      `OpenClaw agent database is unavailable while agent ${normalizeAgentId(deletedAgentId)} is deleted.`,
    );
  }
}

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
    let query = db.selectFrom("agent_deletion_journal").selectAll();
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
  // Existing foreign leases remain blockers even inside the deletion's cleanup scope.
  const cleanup = snapshot.fenceAgentId
    ? undefined
    : getAgentDeletionDatabaseCleanup({
        agentId: snapshot.claimAgentId,
        path: snapshot.claimPath,
        statePath: state.path,
      });
  cleanup?.assertCurrent();
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
    // Ingress is closed by run admission; its existing owners still need writable settlement.
    if (
      row.phase === "draining" &&
      row.cleanup_completed !== 1 &&
      row.agent_id === snapshot.claimAgentId &&
      !snapshot.fenceAgentId
    ) {
      continue;
    }
    const entry = snapshot.entries.find((candidate) =>
      journalFenceFields.every((field) => candidate.row[field] === row[field]),
    );
    if (row.cleanup_completed !== 1 && !entry) {
      throw new AgentDatabaseDeletionRefusedError(
        "Agent deletion journal changed while preparing a database claim.",
      );
    }
    assertAgentDeletionIdentityClaimAllowed(snapshot.claimAgentId, row.agent_id);
    if (row.cleanup_completed === 1) {
      continue;
    }
    // Filesystem canonicalization stays outside the SQLite write transaction; the exact journal
    // row is revalidated here so a concurrent deletion can only make the claim fail closed.
    for (const fence of entry!.fences) {
      const blockedPath = snapshot.targetPaths.find(
        (targetPath) =>
          targetPath === fence.canonicalPath || isPathInside(fence.canonicalPath, targetPath),
      );
      if (blockedPath) {
        throw new AgentDatabaseDeletionRefusedError(
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
  if (row.phase != null && row.phase !== "draining" && row.phase !== "retiring") {
    throw new Error("Invalid agent deletion journal phase.");
  }
  return {
    agentId: row.agent_id,
    operationId: row.operation_id,
    phase: row.phase === "draining" ? "draining" : "retiring",
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

export function parseCleanupPaths(value: string): AgentDeletionJournalCleanupPath[] {
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

export function listPendingAgentDeletionJournalsInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
): { entries: AgentDeletionJournalEntry[]; manualClawAgentIds: string[] } {
  const entries: AgentDeletionJournalEntry[] = [];
  const manualClawAgentIds: string[] = [];
  for (const row of readAgentDeletionPathFenceRows(database.db).rows) {
    if (row.cleanup_completed === 1) {
      continue;
    }
    if (row.phase == null && hasClawDeletionOwnership(database, row.agent_id)) {
      manualClawAgentIds.push(row.agent_id);
    } else {
      entries.push(fromRow(row));
    }
  }
  return { entries, manualClawAgentIds };
}

export function readAgentDeletionJournal(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
  purpose: AgentDeletionJournalPurpose = "maintenance",
): AgentDeletionJournalEntry | undefined {
  // Worker commit guards must read current authority without joining the worker's writer lock.
  return withExistingOpenClawStateDatabaseCurrentReadOnly(
    (database) => readAgentDeletionJournalInDatabase(database, agentId, purpose),
    // Workers can read the live fence directly; repeated inspection children would block their actor.
    purpose === "runtime" && !isMainThread ? { ...options, allowNativeRead: true } : options,
  );
}

export function beginAgentDeletionJournalInDatabase(
  database: OpenClawStateDatabase,
  entry: AgentDeletionJournalInput,
  preserveDeleteFiles = false,
  recoveryOperationId?: string,
): { entry: AgentDeletionJournalEntry; previousEntry?: AgentDeletionJournalEntry } {
  const normalized = {
    ...entry,
    phase: entry.phase ?? "retiring",
    agentId: normalizeAgentId(entry.agentId),
    databasePaths: [
      ...new Set((entry.databasePaths ?? []).map((entryPath) => path.resolve(entryPath))),
    ],
    cleanupPaths: entry.cleanupPaths ?? [],
  };
  sessionChanges.emit({ all: true, scope: "stores" }, database.db);
  ensureAgentDeletionJournalPhaseSchema(database.db);
  const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("agent_deletion_journal").selectAll().where("agent_id", "=", normalized.agentId),
  );
  if (recoveryOperationId !== undefined) {
    if (
      !existing ||
      existing.operation_id !== recoveryOperationId ||
      existing.cleanup_completed !== 0
    ) {
      throw new Error(`Agent ${normalized.agentId} deletion changed before recovery.`);
    }
    if (existing.phase == null && hasClawDeletionOwnership(database, normalized.agentId)) {
      throw new Error(`Agent ${normalized.agentId} deletion requires its Claw removal owner.`);
    }
  }
  const registeredDatabasePaths = executeSqliteQuerySync(
    database.db,
    db.selectFrom("agent_databases").select("path").where("agent_id", "=", normalized.agentId),
  ).rows.flatMap((row) =>
    resolveSqliteDatabaseFilePaths(
      resolveOpenClawRegisteredAgentDatabasePath(database.path, row.path),
    ),
  );
  const previous = existing && fromRow(existing);
  if (preserveDeleteFiles && previous) {
    normalized.deleteFiles = previous.deleteFiles;
  }
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
    const result = {
      previousEntry: previous,
      entry: {
        ...previous,
        operationId: normalized.operationId,
        databasePaths,
        cleanupPaths,
        cleanupCompleted: false,
        deleteFiles: normalized.deleteFiles,
      },
    };
    agentDeletionJournalPublication.stagePostimages(database.db, [
      {
        agentId: result.entry.agentId,
        operationId: result.entry.operationId,
        cleanupCompleted: result.entry.cleanupCompleted,
      },
    ]);
    return result;
  }
  const createdAt = Date.now();
  executeSqliteQuerySync(
    database.db,
    db.insertInto("agent_deletion_journal").values({
      agent_id: normalized.agentId,
      operation_id: normalized.operationId,
      phase: entry.phase ?? null,
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
  const result = {
    entry: { ...normalized, databasePaths, cleanupPaths, createdAt, cleanupCompleted: false },
  };
  agentDeletionJournalPublication.stagePostimages(database.db, [
    {
      agentId: result.entry.agentId,
      operationId: result.entry.operationId,
      cleanupCompleted: result.entry.cleanupCompleted,
    },
  ]);
  return result;
}

export function updateAgentDeletionJournalPathsInDatabase(
  database: OpenClawStateDatabase,
  agentId: string,
  operationId: string,
  column: "cleanup_paths_json" | "database_paths_json",
  paths: readonly AgentDeletionJournalCleanupPath[] | readonly string[],
): boolean {
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
    agentDeletionJournalPublication.stagePostimages(database.db, [
      {
        agentId: normalizeAgentId(agentId),
        operationId: retryOperationId,
        cleanupCompleted: false,
      },
    ]);
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
  ensureAgentDeletionJournalPhaseSchema(database.db);
  const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
  const completed = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .updateTable("agent_deletion_journal")
      .set({ cleanup_completed: 1 })
      .where("agent_id", "=", id)
      .where("operation_id", "=", operationId)
      .where((eb) => eb.or([eb("phase", "is", null), eb("phase", "=", "retiring")]))
      .returning("database_paths_json"),
  );
  // The journal already fences authority. Keep creation history through refusals and
  // partial cleanup, and remove it only when this exact deletion owner completes.
  if (completed) {
    agentDeletionJournalPublication.stagePostimages(database.db, [
      {
        agentId: id,
        operationId,
        cleanupCompleted: true,
      },
    ]);
    resolveAgentDeletionRecoveryHolds(
      database,
      id,
      parseAgentDeletionDatabasePaths(completed.database_paths_json),
    );
    deleteAgentProvenanceForAgent(database.db, id);
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
  }
  return completed !== undefined;
}

/** The caller owns journal authority, transaction admission, and committed publication. */
export function deleteAgentDeletionJournalInDatabase(
  database: OpenClawStateDatabase,
  agentId: string,
  operationId: string,
  completedOnly: boolean,
): boolean {
  const id = normalizeAgentId(agentId);
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
    agentDeletionJournalPublication.stageDeletions(database.db, [id]);
    sessionChanges.emit({ all: true, scope: "stores" }, database.db);
  }
  return removed;
}

/** Read current journal facts through the captured physical shared-state worker. */
export async function readAgentDeletionJournalAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<AgentDeletionJournalEntry | undefined> {
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({ type: "agentDeletion.read", input: { agentId: normalizeAgentId(agentId) } }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return result;
}

/** Keep an effect-boundary journal assertion current through committed owner writes. */
export async function prepareAgentDeletionJournalObservation(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const observation = observeAgentDeletionJournal(agentId, context);
  try {
    const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
    const entry = await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "agentDeletion.read",
          input: { agentId: normalizeAgentId(agentId) },
        }),
      { existingOnly: true },
    );
    observation.seed(entry);
    return {
      entry,
      assertCurrent: (operationId: string) => observation.assertCurrent(operationId),
      release: observation.release,
    };
  } catch (error) {
    observation.release();
    throw error;
  }
}

/** Resume pending deletion work through the captured physical shared-state worker. */
export async function listPendingAgentDeletionJournalsAsync(
  options: OpenClawStateDatabaseOptions = {},
): Promise<ReturnType<typeof listPendingAgentDeletionJournalsInDatabase>> {
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "agentDeletion.listPending", input: undefined }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return result ?? { entries: [], manualClawAgentIds: [] };
}

/** Administrative safety check; the caller retains its own deletion/monitor authority. */
export async function assertNoAgentDatabaseLeasesAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  await executeOpenClawStateWorker(context, {
    type: "agentDeletion.assertNoDatabaseLeasesUnowned",
    input: { agentId: normalizeAgentId(agentId) },
  });
}
