import { isDeepStrictEqual } from "node:util";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  deferOpenClawAgentPostCommitPublication,
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import {
  sqliteLifecycleTargetSnapshotsEqual,
  sqliteSessionEntriesEqual,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLifecycleTargetRows,
  readLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import {
  readSqliteSessionGenerationClaim,
  readSqliteSessionGenerationWindows,
} from "./session-accessor.sqlite-generation-copy.js";
import { prepareCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ReclamationDatabaseOptions,
  ReclamationDeleteParams,
  SessionEntryRemovalPlan,
  SqliteSessionDeletionScope,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  deleteSessionDeliveryArtifacts,
  readSessionNodeArtifactFingerprint,
} from "./session-accessor.sqlite-node-artifacts.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import { withSqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import {
  collectSessionStateIdsForEntry,
  isRecentHistoricalSessionId,
} from "./session-accessor.sqlite-references.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionBoardCleanupDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "board_tabs" | "board_widgets"
> & {
  sqlite_schema: { name: string | null; type: string };
};

const reclamationQueue = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSessionReclamationQueue"),
  () => new KeyedAsyncQueue(),
);

/** Bounds materialized archive bytes through the matching reclamation commit. */
export function runExclusiveSqliteSessionReclamation<T>(run: () => Promise<T>): Promise<T> {
  return reclamationQueue.enqueue("session-reclamation", run);
}

function toWorkerDatabaseOptions(
  options: OpenClawAgentDatabaseOptions,
): ReclamationDatabaseOptions {
  const sourceEnv = options.env ?? process.env;
  const sharedStatePath = options.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv);
  return {
    agentId: normalizeAgentId(options.agentId),
    env: { OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(sharedStatePath) },
    path: resolveOpenClawAgentSqlitePath(options),
  };
}

function deleteSessionBoardRows(
  database: OpenClawAgentDatabase,
  sessionKeys: readonly string[],
): void {
  const keys = [...new Set(sessionKeys)];
  if (keys.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<SessionBoardCleanupDatabase>(database.db);
  const tables = new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "in", ["board_tabs", "board_widgets"]),
    ).rows.map((row) => row.name),
  );
  if (!tables.has("board_tabs") || !tables.has("board_widgets")) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("board_widgets").where("session_key", "in", keys),
  );
  executeSqliteQuerySync(database.db, db.deleteFrom("board_tabs").where("session_key", "in", keys));
}

export function shouldDeleteSqliteSessionEntryLifecycle(
  database: OpenClawAgentDatabase,
  entry: SessionEntry | undefined,
  params: DeleteSessionEntryLifecycleParams,
  scope: SqliteSessionDeletionScope = { kind: "entry", phase: "plan" },
): entry is SessionEntry {
  if (
    params.expectedDatabaseIdentity !== undefined &&
    params.expectedDatabaseIdentity !== readOpenClawAgentDatabaseIdentity(database).identity
  ) {
    return false;
  }
  if (!entry || (params.expectedEntry && !sqliteSessionEntriesEqual(entry, params.expectedEntry))) {
    return false;
  }
  if (
    params.expectedSessionId !== undefined &&
    (params.expectedSessionId === null
      ? entry.sessionId !== undefined
      : entry.sessionId !== params.expectedSessionId)
  ) {
    return false;
  }
  if (
    (params.expectedLifecycleRevision !== undefined &&
      entry.lifecycleRevision !== params.expectedLifecycleRevision) ||
    (params.expectedUpdatedAt !== undefined && entry.updatedAt !== params.expectedUpdatedAt)
  ) {
    return false;
  }
  if (
    scope.kind === "entry" &&
    params.expectedNodeArtifactFingerprint !== undefined &&
    params.expectedNodeArtifactFingerprint !==
      readSessionNodeArtifactFingerprint(database, params.target.canonicalKey)
  ) {
    return false;
  }
  if (params.expectedGenerations) {
    const expected = new Map(
      params.expectedGenerations.map((generation) => [generation.window.session_id, generation]),
    );
    const windows = readSqliteSessionGenerationWindows(
      database,
      scope.kind === "entry" ? [params.target.canonicalKey, ...params.target.storeKeys] : [],
      scope.kind === "entry" ? collectSessionStateIdsForEntry(entry) : [scope.sessionId],
    );
    // Historical cleanup commits one generation at a time; already-copied removals are allowed.
    if (
      windows.some((window) => {
        const generation = expected.get(window.session_id);
        return (
          !generation ||
          !isDeepStrictEqual({ ...generation.window }, { ...window }) ||
          (scope.phase === "commit" &&
            generation.fingerprint !==
              readSqliteSessionGenerationClaim(database, window).fingerprint)
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

type SessionDeletionValidation = {
  deleteParams: DeleteSessionEntryLifecycleParams;
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  scope?: SqliteSessionDeletionScope;
};

export function readValidatedSessionDeletionTarget(
  database: OpenClawAgentDatabase,
  validation: SessionDeletionValidation,
) {
  const snapshot = readLifecycleTargetSnapshot(database, validation.deleteParams.target);
  const entry = snapshot[0]?.entry;
  if (
    !sqliteLifecycleTargetSnapshotsEqual(validation.preparedTargetSnapshot, snapshot) ||
    !shouldDeleteSqliteSessionEntryLifecycle(
      database,
      entry,
      validation.deleteParams,
      validation.scope,
    )
  ) {
    return undefined;
  }
  return { snapshot, entry };
}

export function* prepareHistoricalGenerationDeletions(params: {
  deleteParams: DeleteSessionEntryLifecycleParams;
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  sessionIds: readonly string[];
}): Generator<SessionDeletionValidation & { sessionId: string }> {
  const expected = params.deleteParams.expectedGenerations
    ? new Map(
        params.deleteParams.expectedGenerations.map((generation) => [
          generation.window.session_id,
          generation,
        ]),
      )
    : undefined;
  for (const sessionId of params.sessionIds) {
    const generation = expected?.get(sessionId);
    yield {
      sessionId,
      deleteParams: expected
        ? { ...params.deleteParams, expectedGenerations: generation ? [generation] : [] }
        : params.deleteParams,
      preparedTargetSnapshot: params.preparedTargetSnapshot,
      scope: { kind: "historical-generation", phase: "plan", sessionId },
    };
  }
}

function expectedEntryMismatchResult(): DeleteSessionEntryLifecycleResult {
  return { archivedTranscripts: [], deleted: false, expectedEntryMismatch: true };
}

export function reclaimSqliteSessionInTransaction(
  plan: SqliteSessionReclamationPlan,
  callbacks: {
    beforeMutation?: () => void;
    onCommit?: (database: OpenClawAgentDatabase) => void;
  } = {},
): SqliteSessionReclamationResult {
  if (plan.kind === "entry") {
    const value = runSqliteSessionDeletionTransaction<DeleteSessionEntryLifecycleResult>(
      (transactionDb) => {
        callbacks.beforeMutation?.();
        const current = readValidatedSessionDeletionTarget(transactionDb, {
          ...plan,
          scope: { kind: "entry", phase: "commit" },
        });
        if (!current) {
          return expectedEntryMismatchResult();
        }
        const { snapshot, entry } = current;
        const sessionKeys = [
          plan.deleteParams.target.canonicalKey,
          ...plan.deleteParams.target.storeKeys,
          ...snapshot.map((row) => row.sessionKey),
        ];
        const archivedTranscripts = deleteMaterializedSessionStatePlans(
          transactionDb,
          plan.materializedPlans,
          undefined,
          new Set(sessionKeys),
        );
        deleteLifecycleTargetRows(transactionDb, plan.deleteParams.target);
        if (plan.deleteParams.deleteDeliveryArtifacts === true) {
          deleteSessionDeliveryArtifacts(
            transactionDb,
            plan.deleteParams.target.canonicalKey,
            sessionKeys,
          );
        }
        deleteSessionBoardRows(transactionDb, sessionKeys);
        callbacks.onCommit?.(transactionDb);
        return {
          archivedTranscripts,
          deleted: true,
          deletedEntry: cloneSessionEntry(entry),
          ...(entry.sessionId ? { deletedSessionId: entry.sessionId } : {}),
        };
      },
      plan.databaseOptions,
    );
    return { kind: plan.kind, value };
  }

  if (plan.kind === "lifecycle-artifacts") {
    const value = runSqliteSessionDeletionTransaction((transactionDb) => {
      callbacks.beforeMutation?.();
      assertPlannedLifecycleArtifactEntriesUnchanged(transactionDb, plan.entries);
      const archivedTranscripts = deleteMaterializedSessionStatePlans(
        transactionDb,
        plan.materializedPlans,
        undefined,
        new Set(plan.entries.map((entry) => entry.sessionKey)),
      );
      const removedEntries = deletePlannedLifecycleArtifactEntries(transactionDb, plan.entries);
      callbacks.onCommit?.(transactionDb);
      return { archivedTranscripts, removedEntries };
    }, plan.databaseOptions);
    return { kind: plan.kind, value };
  }

  const value = runOpenClawAgentWriteTransaction((transactionDb) => {
    callbacks.beforeMutation?.();
    const protectedSessionIds = new Set(plan.protectedSessionIds);
    const diskBudget = plan.kind === "history-eviction" ? plan.diskBudget : undefined;
    let excludedSessionKeys: ReadonlySet<string> | undefined;
    if (plan.kind === "historical-generation") {
      const current = readValidatedSessionDeletionTarget(transactionDb, {
        ...plan,
        scope: { kind: "historical-generation", phase: "commit", sessionId: plan.sessionId },
      });
      if (!current) {
        return { archivedTranscripts: [], deleted: false, expectedEntryMismatch: true as const };
      }
      // Explicit deletion excludes its validated owner; automatic pressure does not.
      excludedSessionKeys = new Set([
        plan.deleteParams.target.canonicalKey,
        ...plan.deleteParams.target.storeKeys,
        ...current.snapshot.map((row) => row.sessionKey),
      ]);
    } else if (
      // Node activity can change after the parent dispatches the Worker.
      isRecentHistoricalSessionId({
        database: transactionDb,
        ...plan.diskBudget,
        sessionId: plan.sessionId,
      })
    ) {
      protectedSessionIds.add(plan.sessionId);
    }
    const archivedTranscripts = deleteMaterializedSessionStatePlans(
      transactionDb,
      plan.materializedPlans,
      protectedSessionIds,
      excludedSessionKeys,
      undefined,
      diskBudget,
    );
    const db = getSessionKysely(transactionDb.db);
    const deleted =
      executeSqliteQuerySync(
        transactionDb.db,
        db
          .selectFrom("session_windows")
          .select("session_id")
          .where("session_id", "=", plan.sessionId),
      ).rows.length === 0;
    if (deleted) {
      callbacks.onCommit?.(transactionDb);
    }
    return { archivedTranscripts: deleted ? archivedTranscripts : [], deleted };
  }, plan.databaseOptions);
  if (plan.kind === "history-eviction" && value.deleted) {
    reclaimSqliteFreePagesBestEffort(plan.databaseOptions);
  }
  return { kind: plan.kind, value };
}

function reclaimSqliteFreePagesBestEffort(databaseOptions: ReclamationDatabaseOptions): void {
  try {
    const database = openOpenClawAgentDatabase(databaseOptions);
    // sqlite-allow-raw -- PASSIVE never waits for readers; cap page release per pass.
    database.db.exec("PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(512);");
  } catch {
    // Deletion is already durable. The next budget pass can reclaim pages.
  }
}

function prepareReclamationWorkerTransferList(plan: SqliteSessionReclamationPlan): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const materializedPlan of plan.materializedPlans) {
    const archive = materializedPlan.archive;
    if (!archive) {
      continue;
    }
    const bytes = archive.bytes;
    let owned = bytes;
    let buffer: ArrayBuffer;
    if (
      bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
    ) {
      buffer = bytes.buffer;
    } else {
      buffer = new ArrayBuffer(bytes.byteLength);
      owned = new Uint8Array(buffer);
      owned.set(bytes);
    }
    materializedPlan.archive = { ...archive, bytes: owned };
    buffers.add(buffer);
  }
  return [...buffers];
}

function prepareReclamationPublication(
  plan: SqliteSessionReclamationPlan,
): (() => void) | undefined {
  if (plan.kind === "lifecycle-artifacts") {
    return prepareCommittedSessionEntryRemovals(plan.agentId, plan.entries);
  }
  return undefined;
}

export async function runSqliteSessionReclamation(params: {
  diagnostics?: SqliteSessionReclamationDiagnostics;
  assertCommitAllowed?: () => void;
  forceInProcess: boolean;
  onInProcessCommit?: (database: OpenClawAgentDatabase) => void;
  plan: SqliteSessionReclamationPlan;
}): Promise<SqliteSessionReclamationResult> {
  if (params.diagnostics) {
    params.diagnostics.kind = params.plan.kind;
  }
  if (
    params.forceInProcess ||
    isIncognitoOpenClawAgentSqlitePath(params.plan.databaseOptions.path, {
      agentId: params.plan.databaseOptions.agentId,
      env: params.plan.databaseOptions.env,
    })
  ) {
    return await runExclusiveSqliteSessionWrite(
      params.plan.databaseOptions,
      async () => {
        params.assertCommitAllowed?.();
        return reclaimSqliteSessionInTransaction(params.plan, {
          beforeMutation: params.assertCommitAllowed,
          onCommit: (database) => {
            const publish = prepareReclamationPublication(params.plan);
            if (publish) {
              deferOpenClawAgentPostCommitPublication(database, publish);
            }
            params.onInProcessCommit?.(database);
          },
        });
      },
      "session.reclamation.in-process",
      params.diagnostics,
    );
  }
  return await withSqliteMutationWorkerLifetime(
    params.plan.databaseOptions,
    async ({ assertCurrent, commitGate }) => {
      const assertRequestCurrent = () => {
        assertCurrent();
        params.assertCommitAllowed?.();
      };
      const retained = await runExclusiveSqliteSessionWrite(
        params.plan.databaseOptions,
        async () => {
          assertRequestCurrent();
          return retainOpenClawAgentDatabaseReadOnly(params.plan.databaseOptions);
        },
        "session.reclamation.retain",
      );
      if (!retained.found) {
        throw new Error("SQLite session reclamation lost its prepared database");
      }
      const { database, claim } = retained;
      try {
        // The parent keeps its exact handle live; only the existing cloneable filename crosses threads.
        const plan = {
          ...params.plan,
          databaseOptions: {
            ...params.plan.databaseOptions,
            path: readOpenClawAgentDatabaseIdentity(database).filename,
          },
        };
        return await withSqliteReclamationWorker(
          plan.databaseOptions,
          claim,
          async (worker) => {
            const assertCommitAllowed = () => {
              worker.assertCurrent(plan.databaseOptions, claim);
              assertRequestCurrent();
            };
            assertCommitAllowed();
            let publishCommitted: (() => void) | undefined;
            const result = await withSqliteReclamationAuthorization(
              commitGate,
              database.db,
              () => {
                assertCommitAllowed();
                // A blocked writer may authorize before the Worker's queued request.
                publishCommitted = prepareReclamationPublication(plan);
              },
              (authorize) =>
                worker.run({
                  claim,
                  validationOwner: { database, isCurrent: claim.isCurrent },
                  commitGate,
                  plan,
                  diagnostics: params.diagnostics,
                  onCommitRequest: authorize,
                  withWriteAdmission: async (run, reclamationAdmission) =>
                    await runExclusiveSqliteSessionWrite(
                      plan.databaseOptions,
                      async () => {
                        let refusal: { error: unknown } | undefined;
                        try {
                          assertCommitAllowed();
                        } catch (error) {
                          refusal = { error };
                        }
                        const completed = await run(refusal);
                        if (completed) {
                          // Publish captured identities after transaction settlement, before releasing the writer.
                          publishSessionEntryCacheInvalidation(database);
                          publishCommitted?.();
                        }
                      },
                      "session.reclamation.worker-commit",
                      { ...params.diagnostics, reclamationAdmission },
                      "worker",
                    ),
                  transferList: prepareReclamationWorkerTransferList(plan),
                }),
            );
            return result;
          },
          assertRequestCurrent,
        );
      } finally {
        claim.release();
      }
    },
  );
}

// The live assertion belongs to runSqliteSessionReclamation, never its cloneable plan.
function prepareReclamationDeleteParams({
  commitGuard: _commitGuard,
  ...params
}: DeleteSessionEntryLifecycleParams): ReclamationDeleteParams {
  return params;
}

export function createSessionEntryReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  deleteParams: DeleteSessionEntryLifecycleParams;
  materializedPlans: MaterializedSessionStateDeletePlan[];
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
}): Extract<SqliteSessionReclamationPlan, { kind: "entry" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    deleteParams: prepareReclamationDeleteParams(params.deleteParams),
    kind: "entry",
    materializedPlans: params.materializedPlans,
    preparedTargetSnapshot: params.preparedTargetSnapshot,
  };
}

export function createLifecycleArtifactReclamationPlan(params: {
  agentId: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  entries: SessionEntryRemovalPlan[];
  materializedPlans: MaterializedSessionStateDeletePlan[];
}): Extract<SqliteSessionReclamationPlan, { kind: "lifecycle-artifacts" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    agentId: params.agentId,
    entries: params.entries,
    kind: "lifecycle-artifacts",
    materializedPlans: params.materializedPlans,
  };
}

export function createHistoryEvictionReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  diskBudget: { preserveRecentMs?: number | null };
  materializedPlans: MaterializedSessionStateDeletePlan[];
  protectedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): Extract<SqliteSessionReclamationPlan, { kind: "history-eviction" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    diskBudget: params.diskBudget,
    kind: "history-eviction",
    materializedPlans: params.materializedPlans,
    protectedSessionIds: [...params.protectedSessionIds],
    sessionId: params.sessionId,
  };
}

export function createHistoricalGenerationReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  deleteParams: DeleteSessionEntryLifecycleParams;
  materializedPlans: MaterializedSessionStateDeletePlan[];
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  protectedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): Extract<SqliteSessionReclamationPlan, { kind: "historical-generation" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    deleteParams: prepareReclamationDeleteParams(params.deleteParams),
    kind: "historical-generation",
    materializedPlans: params.materializedPlans,
    preparedTargetSnapshot: params.preparedTargetSnapshot,
    protectedSessionIds: [...params.protectedSessionIds],
    sessionId: params.sessionId,
  };
}
