import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import {
  resolveAgentHarnessSessionStoreError,
  resolveAgentHarnessSessionStoreTransitionError,
} from "../../sessions/agent-harness-session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionArchivedTranscriptCleanupRule } from "./session-accessor.lifecycle-types.js";
import {
  prunePublishedSessionArchivesByRetention,
  publishSessionStateArchives,
} from "./session-accessor.sqlite-archive-store.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import type {
  SessionLifecycleArchivedTranscript,
  DeletedAgentSessionEntryPurgeParams,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntryStatus,
} from "./session-accessor.sqlite-contract.js";
import {
  runPreparedSqliteSessionWrite,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
  withSqliteSessionDeletions,
  hasPreparedNativeSessionDeletion,
} from "./session-accessor.sqlite-deletion.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteSessionEntryRows,
  readExactSessionEntryRow,
  readSessionEntryCount,
  readSessionEntryStore,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { commitSessionEntryLifecycleInWorker } from "./session-accessor.sqlite-entry-worker.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  prepareLifecycleIdentityPublication,
  prepareCommittedSessionEntryRemovals,
} from "./session-accessor.sqlite-identity.js";
import { isSessionLifecycleWorkerInputBounded } from "./session-accessor.sqlite-lifecycle-budget.js";
import {
  commitSessionEntryLifecycleInDatabase,
  type SessionEntryLifecycleCommit,
  type SessionEntryLifecycleCommitted,
} from "./session-accessor.sqlite-lifecycle-commit.js";
import { projectSessionEntryLifecycleMutation } from "./session-accessor.sqlite-lifecycle-projection.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  planSessionStateAfterEntryRemoval,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ProjectedLifecycleMutation,
  SessionEntryMaintenancePlan,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { readSessionEntryLifecycleInWorker } from "./session-accessor.sqlite-lifecycle-worker.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryCreateWithTranscriptOptions } from "./session-accessor.types.js";
import { captureSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type SessionArchiveRuntime = typeof import("../../gateway/session-archive.runtime.js");
let sessionArchiveRuntimePromise: Promise<SessionArchiveRuntime> | undefined;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

export async function applySessionEntryReplacements<T>(params: {
  assertCommitAllowed?: () => void;
  activeSessionKey?: string;
  agentId?: string;
  consumePendingReset?: boolean;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  statuses?: readonly SessionEntryStatus[];
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
}): Promise<T> {
  return await applySessionEntryExactReplacements(params);
}

/**
 * Applies a detached whole-store projection under the SQLite writer lane.
 * This exists only for bounded compatibility adapters that must preserve a
 * legacy serialized callback without exposing mutable storage internals.
 */
export async function applySessionStoreProjection<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  skipMaintenance?: boolean;
  storePath: string;
  update: (store: Record<string, SessionEntry>) =>
    | Promise<{ persist: boolean; result: T }>
    | {
        persist: boolean;
        result: T;
      };
}): Promise<T> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? "",
    storePath: params.storePath,
  });
  const preparedWrite = await runPreparedSqliteSessionWrite(
    resolved,
    async () => {
      return withSqliteSessionDatabase(toDatabaseOptions(resolved), async (database) => {
        const before = readSessionEntryStore(database);
        const projected = structuredClone(before);
        const operation = await params.update(projected);
        if (!operation.persist) {
          return {
            deletedEntries: [],
            commit: () => ({ maintenancePlans: [], result: operation.result }),
          };
        }
        const lockedEntriesBefore = new Map(
          Object.entries(before).filter(([, entry]) => entry.modelSelectionLocked === true),
        );
        const transitionError = resolveAgentHarnessSessionStoreTransitionError({
          before: lockedEntriesBefore,
          store: projected,
        });
        const storeError = resolveAgentHarnessSessionStoreError(projected);
        if (transitionError || storeError) {
          throw new Error(transitionError ?? storeError);
        }

        const changedKeys = uniqueStrings([
          ...Object.keys(before),
          ...Object.keys(projected),
        ]).filter(
          (sessionKey) => !sqliteSessionEntriesEqual(before[sessionKey], projected[sessionKey]),
        );
        if (changedKeys.length === 0) {
          return {
            deletedEntries: [],
            commit: () => ({ maintenancePlans: [], result: operation.result }),
          };
        }

        const maintenancePlans: SessionEntryMaintenancePlan[] = [];
        const deletedOwners = changedKeys.flatMap((sessionKey) => {
          const entry = before[sessionKey];
          return entry && !projected[sessionKey] ? [{ entry, sessionKey }] : [];
        });
        return {
          deletedEntries: deletedOwners,
          commit: (assertSourceCurrent) =>
            withSqliteSessionDatabase(toDatabaseOptions(resolved), () => {
              runOpenClawAgentWriteTransaction(
                (transactionDb) => {
                  assertSourceCurrent?.();
                  for (const sessionKey of changedKeys) {
                    const current = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
                    if (!sqliteSessionEntriesEqual(current, before[sessionKey])) {
                      throw new Error(
                        `SQLite session entry changed before store projection for ${sessionKey}`,
                      );
                    }
                  }
                  for (const sessionKey of changedKeys) {
                    const entry = projected[sessionKey];
                    if (entry) {
                      writeSessionEntry(transactionDb, sessionKey, cloneSessionEntry(entry), {
                        previousEntry: before[sessionKey] ?? null,
                      });
                    } else {
                      deleteSessionEntryRows(transactionDb, sessionKey);
                    }
                  }
                  maintenancePlans.push(
                    applySessionEntryMaintenance(transactionDb, {
                      activeSessionKey: params.activeSessionKey ?? "",
                      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                      skipMaintenance: params.skipMaintenance,
                      storePath: params.storePath,
                    }),
                  );
                },
                toDatabaseOptions(resolved),
                { operationLabel: "session.store-projection" },
              );
              return { maintenancePlans, result: operation.result };
            }),
        };
      });
    },
    "session.store-projection",
  );
  const committed = preparedWrite.result;
  await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
    resolved,
    committed.maintenancePlans,
    { deletedEntriesBeforeMaintenance: preparedWrite.deletedEntries },
  );
  return committed.result;
}

/** Applies exact lifecycle removals/upserts using SQLite session rows. */
export async function applySessionEntryLifecycleMutation(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  captureArtifactCleanupError?: boolean;
  /** Doctor-only bypass while exact malformed rows are removed in the same transaction. */
  allowCanonicalRepair?: boolean;
  /** Doctor-only synchronous state transfer that commits with the destination entry. */
  afterUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  /** Fresh-row sidecar writes that must not retry unrelated pending archives. */
  afterFreshUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  /** Synchronous caller-authority guard checked immediately before lifecycle writes. */
  beforeCommitInTransaction?: () => void;
  /** Retain source authority around the final writer, after projection and native preparation. */
  withCommit?: SessionEntryCreateWithTranscriptOptions["withCommit"];
  /** Non-throwing notification after outer COMMIT, before lifecycle publication and owner cleanup. */
  onLifecycleCommitted?: () => void;
}): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    env: params.env,
    sessionKey: "",
    storePath: params.storePath,
  });
  resolved.env = cloneEnvWithPlatformSemantics(resolved.env ?? process.env);
  resolved.env.OPENCLAW_STATE_DIR = resolveStateDir(resolved.env);
  const databaseOptions = {
    ...toDatabaseOptions(resolved),
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
  };
  resolved.path = databaseOptions.path;
  // Connection-bound guards, Doctor transfers, and fresh-owner assignments retain their native transaction.
  const workerPrepared =
    isMainThread &&
    supportsOpenClawAgentDatabaseExecution(databaseOptions) &&
    params.allowCanonicalRepair !== true &&
    !params.afterUpsertsInTransaction &&
    !params.afterFreshUpsertsInTransaction &&
    !params.beforeCommitInTransaction;
  let useWorker = workerPrepared;
  let databaseIdentity: string | undefined;
  const removals = [...(params.removals ?? [])];
  const upserts = [...(params.upserts ?? [])];
  let artifactCleanupError: unknown;
  const captureArtifactCleanupError = (error: unknown): void => {
    if (params.captureArtifactCleanupError === true) {
      artifactCleanupError ??= error;
      return;
    }
    throw error;
  };
  let projected: ProjectedLifecycleMutation;
  let materializedRemovalPlans: MaterializedSessionStateDeletePlan[] = [];
  let removalArchiveMaterializationFailed = false;
  const preparedWrite = await runPreparedSqliteSessionWrite(
    resolved,
    async () => {
      const prepared = await projectSessionEntryLifecycleMutation(
        databaseOptions,
        {
          ...(params.allowCanonicalRepair ? { allowCanonicalRepair: true } : {}),
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          removals,
          upserts,
        },
        useWorker,
      );
      projected = prepared.projected;
      databaseIdentity = prepared.databaseIdentity;
      useWorker = prepared.useWorker;
      const deletedOwners = projected.removals.flatMap(({ sessionKey, expectedEntry: entry }) => {
        return entry &&
          !projected.upsertedEntries.some((upsert) => upsert.sessionKey === sessionKey)
          ? [{ entry, sessionKey }]
          : [];
      });
      const resetSources = projected.upsertedEntries.flatMap(({ resetBoundary, expectedEntry }) =>
        resetBoundary && expectedEntry?.sessionId ? [expectedEntry.sessionId] : [],
      );
      return {
        deletedEntries: deletedOwners,
        ...(projected.deletePlans.length > 0 || resetSources.length > 0
          ? {
              beforeCommit: async () => {
                if (resetSources.length > 0) {
                  const { restoreSessionColdTranscript } =
                    await import("./session-cold-storage.js");
                  for (const sessionId of new Set(resetSources)) {
                    await restoreSessionColdTranscript({
                      agentId: resolved.agentId,
                      env: resolved.env,
                      storePath: params.storePath,
                      sessionId,
                    });
                  }
                }
                try {
                  materializedRemovalPlans = await materializeSessionStateDeletePlans(
                    projected.deletePlans,
                  );
                } catch (error) {
                  removalArchiveMaterializationFailed = true;
                  captureArtifactCleanupError(error);
                }
              },
            }
          : {}),
        commit: (assertSourceCurrent?: () => void) =>
          commitProjectedLifecycleMutation(assertSourceCurrent),
      };
    },
    "session.lifecycle.mutate",
    params.withCommit,
  );
  const committed = preparedWrite.result;

  async function commitProjectedLifecycleMutation(assertSourceCurrent?: () => void) {
    const maintenanceConfig = params.skipMaintenance
      ? undefined
      : params.maintenanceOverride
        ? { ...resolveMaintenanceConfig(), ...params.maintenanceOverride }
        : resolveMaintenanceConfig();
    const maintenance =
      !maintenanceConfig || maintenanceConfig.mode === "warn"
        ? undefined
        : {
            activeSessionKey: params.activeSessionKey ?? "",
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            forceMaintenance: params.maintenanceOverride !== undefined,
            maintenance: maintenanceConfig,
            preservation: captureSessionMaintenancePreservation(params.storePath),
            storePath: params.storePath,
          };
    const assertCurrent = () => {
      assertSourceCurrent?.();
      if (
        maintenance &&
        !isDeepStrictEqual(
          maintenance.preservation,
          captureSessionMaintenancePreservation(params.storePath),
        )
      ) {
        throw new Error("Session maintenance protection changed before lifecycle mutation");
      }
    };
    const input: SessionEntryLifecycleCommit = {
      projected,
      removalPlans: materializedRemovalPlans,
      materializationFailed: removalArchiveMaterializationFailed,
      allowCanonicalRepair: params.allowCanonicalRepair,
      scope: { ...resolved, env: { ...resolved.env } },
      maintenance,
    };
    let result: SessionEntryLifecycleCommitted;
    if (
      !useWorker ||
      hasPreparedNativeSessionDeletion() ||
      !isSessionLifecycleWorkerInputBounded(input)
    ) {
      result = await withSqliteSessionDatabase(databaseOptions, () => {
        const nativeCommit = runOpenClawAgentWriteTransaction((transactionDb) => {
          if (
            workerPrepared &&
            readOpenClawAgentDatabaseIdentity(transactionDb).identity !== databaseIdentity
          ) {
            throw new Error("Session lifecycle commit lost its prepared database");
          }
          params.beforeCommitInTransaction?.();
          assertSourceCurrent?.();
          if (params.onLifecycleCommitted) {
            deferOpenClawAgentPostCommitPublication(transactionDb, params.onLifecycleCommitted);
          }
          const transactionResult = commitSessionEntryLifecycleInDatabase(transactionDb, input, {
            afterUpsertsInTransaction: params.afterUpsertsInTransaction,
            afterFreshUpsertsInTransaction: params.afterFreshUpsertsInTransaction,
            maintenance: (database) =>
              applySessionEntryMaintenance(database, {
                activeSessionKey: params.activeSessionKey ?? "",
                archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                forceMaintenance: params.maintenanceOverride !== undefined,
                maintenanceConfig,
                skipMaintenance: params.skipMaintenance,
                storePath: params.storePath,
              }),
          });
          return {
            result: transactionResult,
            publish: prepareLifecycleIdentityPublication({
              database: transactionDb,
              agentId: resolved.agentId,
              projected,
              removedSessionKeys: transactionResult.removedSessionKeys,
            }),
          };
        }, databaseOptions);
        nativeCommit.publish();
        return nativeCommit.result;
      });
    } else {
      if (typeof databaseIdentity !== "string") {
        throw new Error("Session lifecycle mutation requires its durable database identity");
      }
      result = await commitSessionEntryLifecycleInWorker(
        databaseOptions,
        databaseIdentity,
        input,
        assertCurrent,
        params.onLifecycleCommitted,
      );
    }
    return {
      ...result,
      // Fresh upserts do not own unrelated archive recovery. Removal retries and
      // Doctor transfers still publish when this commit produced no new archive.
      publishArchives:
        params.skipMaintenance !== true ||
        params.allowCanonicalRepair === true ||
        params.afterUpsertsInTransaction !== undefined ||
        removals.length > 0 ||
        projected.upsertedEntries.length === 0 ||
        projected.upsertedEntries.some(({ expectedEntry }) => expectedEntry !== undefined),
    };
  }

  const { archivedTranscripts: maintenanceArchivedTranscripts, ...maintenance } =
    await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
      resolved,
      committed.maintenancePlans,
      { deletedEntriesBeforeMaintenance: preparedWrite.deletedEntries },
    );
  let publishedRemovalTranscripts: SessionLifecycleArchivedTranscript[] = [];
  try {
    if (committed.publishArchives) {
      publishedRemovalTranscripts = await publishSessionStateArchives(
        resolved,
        committed.archivedTranscripts,
      );
    }
  } catch (error) {
    captureArtifactCleanupError(error);
  }
  const archivedTranscripts = [...publishedRemovalTranscripts, ...maintenanceArchivedTranscripts];
  const counted = useWorker
    ? await readSessionEntryLifecycleInWorker(databaseOptions, {
        stage: "count",
        expectedDatabaseIdentity: databaseIdentity,
      })
    : undefined;
  if (useWorker && (!counted || counted.stage !== "count")) {
    throw new Error("Session lifecycle mutation lost its committed count");
  }
  const afterCount =
    counted?.stage === "count"
      ? counted.count
      : readSessionEntryCount(openOpenClawAgentDatabase(databaseOptions));
  emitArchivedTranscriptUpdates(archivedTranscripts);
  const archivedTranscriptDirectories = uniqueStrings(
    archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
  ).toSorted();
  if (archivedTranscriptDirectories.length > 0 && params.cleanupArchivedTranscripts) {
    try {
      const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
      await cleanupArchivedSessionTranscripts({
        directories: archivedTranscriptDirectories,
        rules: params.cleanupArchivedTranscripts.rules,
        nowMs: params.cleanupArchivedTranscripts.nowMs,
      });
      await prunePublishedSessionArchivesByRetention({
        scope: resolved,
        rules: params.cleanupArchivedTranscripts.rules,
        nowMs: params.cleanupArchivedTranscripts.nowMs,
      });
    } catch (error) {
      captureArtifactCleanupError(error);
    }
  }
  return {
    beforeCount: committed.beforeCount,
    removedEntries: committed.removedSessionKeys.length,
    removedSessionKeys: committed.removedSessionKeys,
    ...maintenance,
    archivedTranscriptDirectories,
    afterCount,
    artifactCleanupError,
  };
}

/** Purges entries owned by a deleted agent from SQLite session rows. */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<void> {
  const resolved = resolveSqliteScope({
    agentId: params.storeAgentId,
    env: params.env,
    sessionKey: "",
    storePath: params.storePath,
  });
  const prepared = await runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      const store = readSessionEntryStore(database);
      const remainingStore = { ...store };
      const entryRemovals: SessionEntryRemovalPlan[] = [];
      const removedEntriesToArchive: SessionEntry[] = [];
      for (const sessionKey of Object.keys(store)) {
        const ownerAgentId = resolveStoredSessionOwnerAgentId({
          cfg: params.cfg,
          agentId: params.storeAgentId,
          sessionKey,
        });
        if (ownerAgentId !== params.agentId) {
          continue;
        }
        const entry = store[sessionKey];
        if (!entry) {
          continue;
        }
        entryRemovals.push({ expectedEntry: cloneSessionEntry(entry), sessionKey });
        removedEntriesToArchive.push(entry);
        delete remainingStore[sessionKey];
      }
      const referencedSessionIds = collectProjectedReferencedSessionIds({
        database,
        excludedSessionKeys: entryRemovals.map((removal) => removal.sessionKey),
        projectedSessionIds: Object.values(remainingStore).flatMap(collectSessionStateIdsForEntry),
      });
      const deletePlans = removedEntriesToArchive.flatMap((entry) =>
        planSessionStateAfterEntryRemoval({
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          database,
          entry,
          reason: "deleted",
          referencedSessionIds,
        }),
      );
      return { deletePlans, entryRemovals };
    },
    "session.agent-purge.prepare",
  );
  const materializedPlans = await materializeSessionStateDeletePlans(prepared.deletePlans);
  const committed = await withSqliteSessionDeletions(
    resolved,
    prepared.entryRemovals.flatMap(({ expectedEntry: entry, sessionKey }) =>
      entry ? [{ entry, sessionKey }] : [],
    ),
    async () =>
      await runExclusiveSqliteSessionWrite(
        resolved,
        async () => {
          let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
          const maintenancePlans: SessionEntryMaintenancePlan[] = [];
          const publishRemovals = runOpenClawAgentWriteTransaction((transactionDb) => {
            const currentOwnedSessionKeys = Object.keys(readSessionEntryStore(transactionDb))
              .filter(
                (sessionKey) =>
                  resolveStoredSessionOwnerAgentId({
                    cfg: params.cfg,
                    agentId: params.storeAgentId,
                    sessionKey,
                  }) === params.agentId,
              )
              .toSorted();
            const plannedSessionKeys = prepared.entryRemovals
              .map((removal) => removal.sessionKey)
              .toSorted();
            if (JSON.stringify(currentOwnedSessionKeys) !== JSON.stringify(plannedSessionKeys)) {
              throw new Error("SQLite deleted-agent session entries changed before purge");
            }
            assertPlannedLifecycleArtifactEntriesUnchanged(transactionDb, prepared.entryRemovals);
            archivedTranscripts = deleteMaterializedSessionStatePlans(
              transactionDb,
              materializedPlans,
              undefined,
              new Set(prepared.entryRemovals.map((removal) => removal.sessionKey)),
            );
            deletePlannedLifecycleArtifactEntries(transactionDb, prepared.entryRemovals);
            const publish = prepareCommittedSessionEntryRemovals(
              resolved.agentId,
              prepared.entryRemovals,
            );
            maintenancePlans.push(
              applySessionEntryMaintenance(transactionDb, {
                activeSessionKey: "",
                archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                storePath: params.storePath,
              }),
            );
            return publish;
          }, toDatabaseOptions(resolved));
          publishRemovals();
          return { archivedTranscripts, maintenancePlans };
        },
        "session.agent-purge.commit",
      ),
  );
  const { archivedTranscripts: maintenanceArchivedTranscripts } =
    await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
      resolved,
      committed.maintenancePlans,
      { deletedEntriesBeforeMaintenance: prepared.entryRemovals.length },
    );
  const archivedTranscripts = [
    ...(await publishSessionStateArchives(resolved, committed.archivedTranscripts)),
    ...maintenanceArchivedTranscripts,
  ];
  emitArchivedTranscriptUpdates(archivedTranscripts);
}

/** Fully replaces rows for one transcript in the additive SQLite transcript store. */
