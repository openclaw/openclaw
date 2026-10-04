import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import {
  prunePublishedSessionArchivesByRetention,
  publishSessionStateArchives,
} from "./session-accessor.sqlite-archive-store.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { withNativeSessionCommitContext } from "./session-accessor.sqlite-commit-context.js";
import type {
  SessionLifecycleArchivedTranscript,
  DeletedAgentSessionEntryPurgeParams,
  SessionEntryLifecycleMutationResult,
} from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  runPreparedSqliteSessionWrite,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import {
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  prepareLifecycleIdentityPublication,
  prepareCommittedSessionEntryRemovals,
} from "./session-accessor.sqlite-identity.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  planSessionStateAfterEntryRemoval,
  projectSessionEntryLifecycleMutation,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ProjectedLifecycleCommitResult,
  ProjectedLifecycleMutation,
  SessionEntryLifecycleMutationParams,
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
  SessionEntryRemovalPlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import { commitProjectedSessionEntryLifecycleMutationInDatabase } from "./session-accessor.sqlite-projection-state.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import { normalizeResolvedMaintenanceConfigInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export { applySessionEntryExactReplacements as applySessionEntryReplacements } from "./session-accessor.sqlite-replacement-projection.js";

/** Applies exact lifecycle removals/upserts using SQLite session rows. */
export async function applySessionEntryLifecycleMutation(
  params: SessionEntryLifecycleMutationParams,
): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = captureLifecycleDatabaseScope(
    resolveSqliteScope({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      env: params.env,
      sessionKey: "",
      storePath: params.storePath,
    }),
  );
  const removals = [...(params.removals ?? [])];
  const upserts = [...(params.upserts ?? [])];
  const databaseOptions = toDatabaseOptions(resolved);
  const useWorker =
    isMainThread &&
    upserts.length === 0 &&
    !params.afterUpsertsInTransaction &&
    !params.afterFreshUpsertsInTransaction &&
    !params.beforeCommitInTransaction &&
    !params.afterCommitted &&
    supportsOpenClawAgentDatabaseExecution(databaseOptions);
  const reclamationOptions = useWorker
    ? resolveSessionReclamationDatabaseOptions(databaseOptions)
    : undefined;
  const execution = reclamationOptions
    ? captureOpenClawAgentDatabaseExecution(reclamationOptions)
    : undefined;
  try {
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
        const projectionInput = {
          ...(params.allowCanonicalRepair ? { allowCanonicalRepair: true } : {}),
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          removals,
        };
        if (reclamationOptions) {
          await prepareSessionEntryReplacementDatabase(
            reclamationOptions,
            () => execution?.assertCurrent(),
            execution,
          );
          const result = await runSqliteSessionReclamation({
            forceInProcess: false,
            assertCommitAllowed: () => execution?.assertCurrent(),
            plan: {
              kind: "lifecycle-projection-plan",
              databaseOptions: reclamationOptions,
              materializedPlans: [],
              input: projectionInput,
            },
          });
          if (result.kind !== "lifecycle-projection-plan") {
            throw new Error("SQLite lifecycle projection returned an unexpected planning result");
          }
          projected = result.value;
        } else {
          projected = await projectSessionEntryLifecycleMutation(databaseOptions, {
            ...projectionInput,
            upserts,
          });
        }
        const deletedOwners = projected.removals.flatMap(({ sessionKey, expectedEntry: entry }) => {
          return entry &&
            !projected.upsertedEntries.some((upsert) => upsert.sessionKey === sessionKey)
            ? [{ entry, sessionKey }]
            : [];
        });
        const resetSources = projected.upsertedEntries.flatMap(
          ({ resetBoundary, expectedEntry }) =>
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
          commit: async (assertSourceCurrent?: () => void) => {
            if (reclamationOptions && !hasPreparedNativeSessionDeletion()) {
              const preparedPreservation = params.skipMaintenance
                ? undefined
                : await prepareSessionMaintenancePreservation(params.storePath);
              try {
                const maintenance: SessionEntryMaintenanceInput | null = preparedPreservation
                  ? {
                      activeSessionKey: params.activeSessionKey ?? "",
                      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                      forceMaintenance: params.maintenanceOverride !== undefined,
                      maintenance: normalizeResolvedMaintenanceConfigInput({
                        ...resolveMaintenanceConfig(),
                        ...params.maintenanceOverride,
                      }),
                      preservation: preparedPreservation.capture(),
                      storePath: params.storePath,
                    }
                  : null;
                const assertCurrent = () => {
                  execution?.assertCurrent();
                  params.commitGuard?.();
                  assertSourceCurrent?.();
                  if (
                    maintenance &&
                    preparedPreservation &&
                    !isDeepStrictEqual(maintenance.preservation, preparedPreservation.capture())
                  ) {
                    throw new Error(
                      "Session maintenance protection changed before lifecycle removal",
                    );
                  }
                };
                const result = await runSqliteSessionReclamation({
                  forceInProcess: false,
                  assertCommitAllowed: assertCurrent,
                  onWorkerResult: (completed) => {
                    if (completed.kind === "lifecycle-projection-commit") {
                      params.onLifecycleCommitted?.();
                    }
                  },
                  plan: {
                    kind: "lifecycle-projection-commit",
                    agentId: resolved.agentId,
                    databaseOptions: reclamationOptions,
                    materializedPlans: materializedRemovalPlans,
                    descendantRunBasis: params.descendantRunBasis,
                    maintenanceRunBasis: preparedPreservation?.subagentRunBasis,
                    input: {
                      projected,
                      materializationFailed: removalArchiveMaterializationFailed,
                      allowCanonicalRepair: params.allowCanonicalRepair,
                      maintenance,
                    },
                  },
                });
                if (result.kind !== "lifecycle-projection-commit") {
                  throw new Error(
                    "SQLite lifecycle projection returned an unexpected commit result",
                  );
                }
                return withArchivePublication(result.value);
              } finally {
                preparedPreservation?.dispose();
              }
            }
            return withSqliteSessionDatabase(toDatabaseOptions(resolved), (database) =>
              withNativeSessionCommitContext(
                database,
                resolved.env,
                (source) =>
                  commitProjectedLifecycleMutation(
                    materializedRemovalPlans,
                    removalArchiveMaterializationFailed,
                    () => {
                      assertSourceCurrent?.();
                      source?.assertCurrent();
                    },
                  ),
                params.afterCommitted,
              ),
            );
          },
        };
      },
      "session.lifecycle.mutate",
      params.withCommit,
      undefined,
      useWorker ? "worker" : "foreground",
    );
    const committed = preparedWrite.result;

    function commitProjectedLifecycleMutation(
      removalPlans: MaterializedSessionStateDeletePlan[],
      materializationFailed: boolean,
      assertSourceCurrent?: () => void,
    ) {
      const commitResult = runOpenClawAgentWriteTransaction(
        (transactionDb) => {
          execution?.assertCurrent();
          params.commitGuard?.();
          params.beforeCommitInTransaction?.();
          assertSourceCurrent?.();
          assertSessionSubagentRunsCurrent(params, resolved.env);
          if (params.onLifecycleCommitted) {
            deferOpenClawAgentPostCommitPublication(transactionDb, params.onLifecycleCommitted);
          }
          const result = commitProjectedSessionEntryLifecycleMutationInDatabase(transactionDb, {
            projected,
            removalPlans,
            materializationFailed,
            allowCanonicalRepair: params.allowCanonicalRepair,
            resetScope: resolved,
            afterUpsertsInTransaction: params.afterUpsertsInTransaction,
            afterFreshUpsertsInTransaction: params.afterFreshUpsertsInTransaction,
            applyMaintenance: (database) =>
              applySessionEntryMaintenance(database, {
                activeSessionKey: params.activeSessionKey ?? "",
                archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                forceMaintenance: params.maintenanceOverride !== undefined,
                maintenanceConfig: params.maintenanceOverride
                  ? { ...resolveMaintenanceConfig(), ...params.maintenanceOverride }
                  : undefined,
                skipMaintenance: params.skipMaintenance,
                storePath: params.storePath,
              }),
          });
          params.commitGuard?.();
          assertSourceCurrent?.();
          assertSessionSubagentRunsCurrent(params, resolved.env);
          return {
            ...result,
            publish: prepareLifecycleIdentityPublication({
              database: transactionDb,
              agentId: resolved.agentId,
              projected,
              removedSessionKeys: result.removedSessionKeys,
            }),
          };
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.lifecycle.project" },
      );
      commitResult.publish();
      return withArchivePublication(commitResult);
    }

    function withArchivePublication(commitResult: ProjectedLifecycleCommitResult) {
      return {
        ...commitResult,
        // Fresh upserts do not own unrelated archive recovery. Removal retries and
        // Doctor transfers still publish when this commit produced no new archive.
        publishArchives:
          commitResult.archivedTranscripts.length > 0 ||
          params.allowCanonicalRepair === true ||
          params.afterUpsertsInTransaction !== undefined ||
          removals.length > 0 ||
          ((commitResult.pendingArchives ||
            params.withCommit !== undefined ||
            projected.upsertedEntries.some(({ resetBoundary }) => resetBoundary !== undefined)) &&
            (params.skipMaintenance !== true ||
              projected.upsertedEntries.length === 0 ||
              projected.upsertedEntries.some(({ expectedEntry }) => expectedEntry !== undefined))),
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
    let afterCount: number;
    if (reclamationOptions) {
      const result = await runSqliteSessionReclamation({
        forceInProcess: false,
        assertCommitAllowed: () => execution?.assertCurrent(),
        plan: {
          kind: "lifecycle-projection-count",
          databaseOptions: reclamationOptions,
          materializedPlans: [],
        },
      });
      if (result.kind !== "lifecycle-projection-count") {
        throw new Error("SQLite lifecycle projection returned an unexpected count result");
      }
      afterCount = result.value;
    } else {
      afterCount = readSessionEntryCount(openOpenClawAgentDatabase(databaseOptions));
    }
    emitArchivedTranscriptUpdates(archivedTranscripts);
    const archivedTranscriptDirectories = uniqueStrings(
      archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
    ).toSorted();
    if (archivedTranscriptDirectories.length > 0 && params.cleanupArchivedTranscripts) {
      try {
        const { cleanupArchivedSessionTranscripts } =
          await import("../../gateway/session-archive.runtime.js");
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
  } finally {
    await execution?.release();
  }
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
        entryRemovals.push({ expectedEntry: structuredClone(entry), sessionKey });
        removedEntriesToArchive.push(entry);
        delete remainingStore[sessionKey];
      }
      const referencedSessionIds = collectProjectedReferencedSessionIds({
        database,
        excludedSessionKeys: entryRemovals.map((removal) => removal.sessionKey),
        projectedStore: remainingStore,
        candidateSessionIds: removedEntriesToArchive.flatMap(collectSessionStateIdsForEntry),
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
          const publishRemovals = runOpenClawAgentWriteTransaction(
            (transactionDb) => {
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
                readOpenClawAgentDatabaseIdentity(transactionDb).identity,
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
            },
            toDatabaseOptions(resolved),
            { operationLabel: "session.entry.purge-deleted-agent" },
          );
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
