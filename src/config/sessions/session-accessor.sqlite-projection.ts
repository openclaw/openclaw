import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
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
  SessionEntryLifecycleMutationResult,
} from "./session-accessor.sqlite-contract.js";
import {
  captureNativeSessionWorkerDeletion,
  hasPreparedNativeSessionDeletion,
  runPreparedSqliteSessionWrite,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
} from "./session-accessor.sqlite-deletion.js";
import { readSessionEntryCount } from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { prepareLifecycleIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { projectSessionEntryLifecycleMutation } from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ProjectedLifecycleCommitResult,
  ProjectedLifecycleMutation,
  SessionEntryLifecycleMutationParams,
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
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
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import {
  commitSessionLifecycleProjectionInWorker,
  projectSessionEntryLifecycleMutationInWorker,
  readSessionEntryLifecycleCountInWorker,
} from "./session-lifecycle-projection.js";
import { assertMaintenancePreservationCompatible } from "./store-maintenance-preserve-snapshot.js";
import {
  prepareSessionMaintenancePreservation,
  type PreparedSessionMaintenancePreservation,
} from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import { normalizeResolvedMaintenanceConfigInput } from "./store-maintenance.js";

export { purgeDeletedAgentSessionEntries } from "./session-agent-purge.js";

export { applySessionEntryExactReplacements as applySessionEntryReplacements } from "./session-accessor.sqlite-replacement-projection.js";

/** Applies exact lifecycle removals/upserts using SQLite session rows. */
export async function applySessionEntryLifecycleMutation(
  params: SessionEntryLifecycleMutationParams,
  resolved = captureLifecycleDatabaseScope(
    resolveSqliteScope({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      env: params.env,
      sessionKey: "",
      storePath: params.storePath,
    }),
  ),
): Promise<SessionEntryLifecycleMutationResult> {
  const removals = [...(params.removals ?? [])];
  const upserts = [...(params.upserts ?? [])];
  const databaseOptions = toDatabaseOptions(resolved);
  const useWorker =
    isMainThread &&
    !params.allowCanonicalRepair &&
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
        }
        if (reclamationOptions && execution) {
          projected = await projectSessionEntryLifecycleMutationInWorker({
            database: reclamationOptions,
            execution,
            input: projectionInput,
            upserts,
          });
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
            const nativeMaintenance =
              !reclamationOptions ||
              (hasPreparedNativeSessionDeletion() &&
                !captureNativeSessionWorkerDeletion(deletedOwners));
            const preparedPreservation = params.skipMaintenance
              ? undefined
              : await prepareSessionMaintenancePreservation(params.storePath, {
                  native: nativeMaintenance,
                });
            try {
              if (reclamationOptions && !nativeMaintenance) {
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
                };
                const assertPreservationCurrent = (
                  plans?: readonly SessionEntryMaintenancePlan[],
                ) => {
                  if (maintenance?.preservation && preparedPreservation) {
                    assertMaintenancePreservationCompatible(
                      maintenance.preservation,
                      preparedPreservation.capture(),
                      plans,
                    );
                  }
                };
                if (upserts.length > 0 && execution && !hasPreparedNativeSessionDeletion()) {
                  return withArchivePublication(
                    await commitSessionLifecycleProjectionInWorker({
                      database: reclamationOptions,
                      execution,
                      assertCurrent,
                      assertPrepared: () => {
                        preparedPreservation?.capture();
                      },
                      assertCandidate: (candidate) =>
                        assertPreservationCurrent(candidate.result.maintenancePlans),
                      onLifecycleCommitted: params.onLifecycleCommitted,
                      input: {
                        agentId: resolved.agentId,
                        projected,
                        removalPlans: materializedRemovalPlans,
                        materializationFailed: removalArchiveMaterializationFailed,
                        allowCanonicalRepair: params.allowCanonicalRepair,
                        maintenance,
                      },
                    }),
                  );
                }
                const result = await runSqliteSessionReclamation({
                  forceInProcess: false,
                  assertCommitAllowed: () => {
                    assertCurrent();
                    assertPreservationCurrent();
                  },
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
              }
              return await withSqliteSessionDatabase(toDatabaseOptions(resolved), (database) =>
                withNativeSessionCommitContext(
                  database,
                  resolved.env,
                  (source) =>
                    commitProjectedLifecycleMutation(
                      materializedRemovalPlans,
                      removalArchiveMaterializationFailed,
                      preparedPreservation,
                      () => {
                        assertSourceCurrent?.();
                        source?.assertCurrent();
                      },
                    ),
                  params.afterCommitted,
                ),
              );
            } finally {
              preparedPreservation?.dispose();
            }
          },
        };
      },
      "session.lifecycle.mutate",
      params.withCommit,
      undefined,
      useWorker && upserts.length === 0 ? "worker" : "foreground",
    );
    const committed = preparedWrite.result;

    function commitProjectedLifecycleMutation(
      removalPlans: MaterializedSessionStateDeletePlan[],
      materializationFailed: boolean,
      preservation: PreparedSessionMaintenancePreservation | undefined,
      assertSourceCurrent?: () => void,
    ) {
      const commitResult = runOpenClawAgentWriteTransaction(
        (transactionDb) => {
          execution?.assertCurrent();
          params.commitGuard?.();
          params.beforeCommitInTransaction?.();
          assertSourceCurrent?.();
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
                preservation: preservation?.capture,
                refreshCandidates: preservation?.refreshCandidates,
                storePath: params.storePath,
              }),
          });
          params.commitGuard?.();
          assertSourceCurrent?.();
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
    const afterCount =
      reclamationOptions && execution
        ? await readSessionEntryLifecycleCountInWorker({ database: reclamationOptions, execution })
        : readSessionEntryCount(openOpenClawAgentDatabase(databaseOptions));
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
