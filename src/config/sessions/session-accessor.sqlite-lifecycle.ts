import { isMainThread } from "node:worker_threads";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { collectActiveSessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { deletePersonalGitHubSessionReceipts } from "../../state/github-personal-publication-lifecycle.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  deferOpenClawAgentPostCommitPublication,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseExecutionFileIdentity } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import type { ResetSessionEntryLifecycleMutation } from "./session-accessor.lifecycle-types.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import type {
  SessionLifecycleArchivedTranscript,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SqliteSessionArtifactPreparationDiagnostics,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  assertLifecycleTargetUnchanged,
  readLifecycleTargetSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { publishCommittedSessionEntryRemoval } from "./session-accessor.sqlite-identity.js";
import { prepareSessionLifecycleArtifactCleanup } from "./session-accessor.sqlite-lifecycle-artifacts.js";
import { refreshSqliteSessionPlannerStatisticsBestEffort } from "./session-accessor.sqlite-maintenance.js";
import {
  runSessionDeletionPlanning,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation-run.js";
import {
  createHistoricalGenerationReclamationPlan,
  createLifecycleArtifactReclamationPlan,
  createSessionEntryReclamationPlan,
  expectedEntryMismatchResult,
  prepareHistoricalGenerationDeletions,
  runExclusiveSqliteSessionReclamation,
  resolveSessionReclamationDatabaseOptions,
} from "./session-accessor.sqlite-reclamation.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import { appendSessionResetBoundary } from "./session-accessor.sqlite-reset-boundary.js";
import {
  captureLifecycleDatabaseScope,
  cloneSessionEntry,
  resolveSqliteAgentId,
  resolveSqliteReadScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

// Single-target lifecycle owner: cleanup, reset, guarded delete, and trusted rollback.

async function withCommittedHistoryMaintenance<T>(
  { agentId, env, storePath }: { agentId?: string; env?: NodeJS.ProcessEnv; storePath: string },
  run: (
    recordCommit: (database: OpenClawAgentDatabase) => void,
    markCommitted: () => void,
  ) => Promise<T>,
  options: { scheduleNext?: boolean } = {},
): Promise<T> {
  let committed = false;
  try {
    return await run(
      (database) => {
        deferOpenClawAgentPostCommitPublication(database, () => {
          committed = true;
        });
      },
      () => {
        committed = true;
      },
    );
  } finally {
    // A partial commit still needs maintenance, but only after archive publication and
    // lifecycle-owner cleanup finish. Rejected preparation or rollback creates no pressure.
    if (committed && options.scheduleNext !== false) {
      kickSessionHistoryDiskBudgetMaintenance({ agentId, env, storePath, force: true });
    }
  }
}

export async function cleanupSessionLifecycleArtifactsCore(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  const pluginOwnerId = params.pluginOwnerId?.trim();
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }

  const resolved = captureLifecycleDatabaseScope(
    resolveSqliteReadScope({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      storePath: params.storePath,
    }),
  );
  const databaseOptions = toDatabaseOptions(resolved);
  const artifactPreparation: SqliteSessionArtifactPreparationDiagnostics = {};
  const cleanupPlan = await runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      prepareSessionLifecycleArtifactCleanup(databaseOptions, {
        ...(params.agentId !== undefined ? { agentId: resolved.agentId } : {}),
        archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts !== false,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        ...(pluginOwnerId ? { pluginOwnerId } : {}),
        sessionKeySegmentPrefix,
        transcriptContentMarker,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        nowMs: params.nowMs ?? Date.now(),
        diagnostics: artifactPreparation,
      }),
    "session.lifecycle.artifacts-prepare",
    { artifactPreparation },
  );
  if (cleanupPlan.entries.length === 0 && cleanupPlan.deletePlans.length === 0) {
    // Startup probes need no reclamation Worker, but previously committed archives
    // still need their publication retry even when this pass has no deletions.
    await publishSessionStateArchives(resolved, []);
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }
  const committed = await withSqliteSessionDeletions(
    resolved,
    cleanupPlan.entries.flatMap(({ expectedEntry: entry, sessionKey }) =>
      entry ? [{ entry, sessionKey }] : [],
    ),
    async (assertCurrent) =>
      await runExclusiveSqliteSessionReclamation(async () => {
        const materializedPlans = await materializeSessionStateDeletePlans(cleanupPlan.deletePlans);
        const diagnostics: SqliteSessionReclamationDiagnostics = {};
        const plan = createLifecycleArtifactReclamationPlan({
          agentId: resolved.agentId,
          databaseOptions,
          entries: cleanupPlan.entries,
          materializedPlans,
        });
        const reclaimed = await runSqliteSessionReclamation({
          diagnostics,
          assertCommitAllowed: assertCurrent,
          forceInProcess: hasPreparedNativeSessionDeletion(),
          plan,
        });
        if (reclaimed.kind !== plan.kind) {
          throw new Error(`SQLite session reclamation returned ${reclaimed.kind} for ${plan.kind}`);
        }
        return reclaimed.value;
      }),
    { additionalIdentities: cleanupPlan.deletePlans.map((plan) => plan.sessionId) },
  );
  // The SQL commit survives a later archive-publication failure, so refresh
  // planner statistics before crossing that separate artifact boundary.
  const deletedEntries = Math.max(
    committed.removedEntries,
    new Set(cleanupPlan.deletePlans.map((plan) => plan.sessionId)).size,
  );
  await refreshSqliteSessionPlannerStatisticsBestEffort(resolved, deletedEntries);
  const archivedTranscripts = await publishSessionStateArchives(
    resolved,
    committed.archivedTranscripts,
  );
  return {
    removedEntries: committed.removedEntries,
    archivedTranscriptArtifacts: archivedTranscripts.length,
  };
}

/** Resets one persisted session entry using SQLite session rows. */
export async function resetSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  const agentId = params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId;
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId });
  if (params.resetBoundary) {
    params.commitGuard?.();
    const source = withOpenClawAgentDatabaseReadOnly(
      (database) => readLifecycleTargetSnapshot(database, params.target)[0]?.entry.sessionId,
      toDatabaseOptions(resolved),
    );
    if (source.found && source.value) {
      const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
      await restoreSessionColdTranscript({
        agentId: resolved.agentId,
        env: resolved.env,
        storePath: params.storePath,
        sessionId: source.value,
      });
    }
  }
  return await withCommittedHistoryMaintenance(
    { agentId: resolved.agentId, storePath: params.storePath },
    async (recordCommit) =>
      runExclusiveSqliteSessionWrite(
        resolved,
        async () => {
          params.commitGuard?.();
          const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
          const targetSnapshot = readLifecycleTargetSnapshot(database, params.target);
          const current = targetSnapshot[0];
          const nextEntry = await params.buildNextEntry({
            currentEntry: current ? cloneSessionEntry(current.entry) : undefined,
            primaryKey: params.target.canonicalKey,
          });
          const shouldAppendResetBoundary =
            params.resetBoundary &&
            current?.entry.sessionId &&
            !sqliteSessionEntriesEqual(current.entry, nextEntry);
          const mutation: ResetSessionEntryLifecycleMutation = {
            nextEntry: cloneSessionEntry(nextEntry),
            ...(current ? { previousEntry: cloneSessionEntry(current.entry) } : {}),
            ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
          };
          const databaseIdentity = runOpenClawAgentWriteTransaction(
            (transactionDb) => {
              params.commitGuard?.();
              assertLifecycleTargetUnchanged(transactionDb, params.target, current?.entry, "reset");
              if (shouldAppendResetBoundary && current?.entry.sessionId && params.resetBoundary) {
                const boundaryScope = {
                  ...resolved,
                  sessionId: current.entry.sessionId,
                  sessionKey: current.sessionKey,
                };
                appendSessionResetBoundary(
                  transactionDb,
                  boundaryScope,
                  current.entry,
                  params.resetBoundary,
                );
              }
              writeSessionEntry(transactionDb, params.target.canonicalKey, nextEntry, {
                previousEntry: current?.entry ?? null,
              });
              recordCommit(transactionDb);
              // Reset only advances the live entry and route. Historical rows stay searchable;
              // disk-budget cleanup owns durable extraction before reclaiming them.
              return readOpenClawAgentDatabaseIdentity(transactionDb).identity;
            },
            toDatabaseOptions(resolved),
            { operationLabel: "session.lifecycle.reset" },
          );
          emitSessionIdentityMutation({
            agentId: resolved.agentId,
            databaseIdentity,
            kind: current ? "reset" : "create",
            previous: current
              ? {
                  ...(current.entry.sessionId ? { sessionId: current.entry.sessionId } : {}),
                  sessionKeys: targetSnapshot.map((row) => row.sessionKey),
                }
              : { sessionKeys: [] },
            current: {
              ...(nextEntry.sessionId ? { sessionId: nextEntry.sessionId } : {}),
              sessionKeys: [params.target.canonicalKey],
            },
          });
          await params.afterEntryMutation?.(mutation);
          return {
            ...mutation,
            archivedTranscripts: [],
          };
        },
        "session.lifecycle.reset",
      ),
  );
}

async function deleteSqliteSessionEntryLifecycleInternal(
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId?: string,
): Promise<DeleteSessionEntryLifecycleResult> {
  const agentId = params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId;
  const resolved = captureLifecycleDatabaseScope(
    resolveSqliteStoreScope(params.storePath, { agentId }),
  );
  return await withCommittedHistoryMaintenance(
    { ...params, env: resolved.env },
    async (recordCommit, markCommitted) =>
      deleteSqliteSessionEntryLifecycleLocked(
        resolved,
        params,
        allowLockedEntryRemoval,
        expectedPluginOwnerId,
        recordCommit,
        markCommitted,
      ),
  );
}

const DELETE_EXPECTED_ENTRY_MISMATCH = Symbol("delete-expected-entry-mismatch");

async function deleteSqliteSessionEntryLifecycleLocked(
  requestedScope: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId: string | undefined,
  recordCommit: (database: OpenClawAgentDatabase) => void,
  markCommitted: () => void,
): Promise<DeleteSessionEntryLifecycleResult> {
  const requestedDatabaseOptions = toDatabaseOptions(requestedScope);
  const useWorker =
    isMainThread &&
    params.expectedDatabaseIdentity === undefined &&
    supportsOpenClawAgentDatabaseExecution(requestedDatabaseOptions);
  const opened = useWorker ? getOpenClawAgentDatabaseIfOpen(requestedDatabaseOptions) : undefined;
  const openedIdentity = opened ? readOpenClawAgentDatabaseIdentity(opened) : undefined;
  const expectedIdentity: AgentDatabaseExecutionFileIdentity | undefined =
    openedIdentity && typeof openedIdentity.identity === "string"
      ? {
          kind: "file",
          physicalIdentity: openedIdentity.identity,
          birthtime: openedIdentity.birthtime,
          nativeLocation: openedIdentity.filename,
        }
      : undefined;
  // An opened alias already selected its native owner; later retargeting cannot redirect this deletion.
  const resolved = expectedIdentity
    ? { ...requestedScope, path: expectedIdentity.nativeLocation }
    : requestedScope;
  const databaseOptions = toDatabaseOptions(resolved);
  const reclamationOptions = useWorker
    ? resolveSessionReclamationDatabaseOptions(databaseOptions)
    : undefined;
  const execution = reclamationOptions
    ? captureOpenClawAgentDatabaseExecution(
        reclamationOptions,
        expectedIdentity ? { expectedIdentity } : {},
      )
    : undefined;
  const assertSourceCurrent = () => {
    execution?.assertCurrent();
    params.commitGuard?.();
  };
  try {
    return await withSqliteTranscriptArchiveSession(databaseOptions, async () => {
      if (reclamationOptions) {
        await prepareSessionEntryReplacementDatabase(
          reclamationOptions,
          assertSourceCurrent,
          execution,
        );
      }
      const {
        commitGuard: _commitGuard,
        expectedDatabaseIdentity: _expectedDatabaseIdentity,
        descendantRunBasis: _descendantRunBasis,
        ...deleteParams
      } = params;
      const preparation = await runSessionDeletionPlanning(
        resolved,
        params,
        {
          operation: "entry",
          input: {
            deleteParams,
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            admissionIdentities: [
              ...(collectActiveSessionWorkAdmissions().get(params.storePath) ?? []),
            ],
            allowLockedEntryRemoval,
            expectedPluginOwnerId,
          },
        },
        assertSourceCurrent,
      );
      if (preparation.operation !== "entry") {
        throw new Error(
          `SQLite session deletion planning returned ${preparation.operation} for entry`,
        );
      }
      if (preparation.value.kind === "missing") {
        await publishSessionStateArchives(resolved, []);
        return { archivedTranscripts: [], deleted: false };
      }
      if (preparation.value.kind === "expected-entry-mismatch") {
        await publishSessionStateArchives(resolved, []);
        return expectedEntryMismatchResult([]);
      }
      const prepared = preparation.value.value;

      return await withSqliteSessionDeletions(
        resolved,
        prepared.targetSnapshot,
        async (assertCurrent) => {
          const assertDeletionCurrent = () => {
            assertSourceCurrent();
            assertCurrent();
          };
          const validation = {
            deleteParams: params,
            preparedTargetSnapshot: prepared.targetSnapshot,
          };
          const historicalArchivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
          for (const generation of prepareHistoricalGenerationDeletions({
            ...validation,
            sessionIds: prepared.historicalGenerationIds,
          })) {
            const { sessionId } = generation;
            const {
              commitGuard: _generationGuard,
              expectedDatabaseIdentity: _generationIdentity,
              descendantRunBasis: _generationBasis,
              ...generationParams
            } = generation.deleteParams;
            const generationValidation = {
              deleteParams: generationParams,
              preparedTargetSnapshot: prepared.targetSnapshot,
              scope: generation.scope,
            };
            const planning = await runSessionDeletionPlanning(
              resolved,
              params,
              {
                operation: "history",
                input: {
                  validation: generationValidation,
                  sessionId,
                  archiveDirectory: prepared.archiveDirectory,
                  archiveTranscript: params.archiveTranscript,
                  admissionIdentities: [
                    ...(collectActiveSessionWorkAdmissions().get(params.storePath) ?? []),
                  ],
                },
              },
              assertDeletionCurrent,
            );
            if (planning.operation !== "history") {
              throw new Error(
                `SQLite session deletion planning returned ${planning.operation} for history`,
              );
            }
            if (planning.value.kind === "expected-entry-mismatch") {
              return expectedEntryMismatchResult(historicalArchivedTranscripts);
            }
            if (planning.value.kind === "skip") {
              continue;
            }
            const plan = planning.value.plan;
            const archivedGeneration = await runExclusiveSqliteSessionReclamation(async () => {
              const materializedGeneration = await materializeSessionStateDeletePlans([plan]);
              const diagnostics: SqliteSessionReclamationDiagnostics = {};
              const checked = await runSessionDeletionPlanning(
                resolved,
                params,
                {
                  operation: "check",
                  input: {
                    validation: generationValidation,
                    sessionId,
                    admissionIdentities: [
                      ...(collectActiveSessionWorkAdmissions().get(params.storePath) ?? []),
                    ],
                  },
                },
                assertDeletionCurrent,
                diagnostics,
              );
              if (checked.operation !== "check") {
                throw new Error(
                  `SQLite session deletion planning returned ${checked.operation} for check`,
                );
              }
              if (checked.value.kind === "expected-entry-mismatch") {
                return DELETE_EXPECTED_ENTRY_MISMATCH;
              }
              const reclamationPlan = createHistoricalGenerationReclamationPlan({
                databaseOptions,
                deleteParams: generation.deleteParams,
                materializedPlans: materializedGeneration,
                preparedTargetSnapshot: prepared.targetSnapshot,
                protectedSessionIds: new Set(checked.value.protectedSessionIds),
                sessionId,
              });
              const reclaimed = await runSqliteSessionReclamation({
                diagnostics,
                assertCommitAllowed: assertDeletionCurrent,
                forceInProcess:
                  typeof params.expectedDatabaseIdentity === "symbol" ||
                  hasPreparedNativeSessionDeletion(),
                onInProcessCommit: recordCommit,
                plan: reclamationPlan,
              });
              if (reclaimed.kind !== reclamationPlan.kind) {
                throw new Error(
                  `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
                );
              }
              return reclaimed.value;
            });
            if (archivedGeneration === DELETE_EXPECTED_ENTRY_MISMATCH) {
              return expectedEntryMismatchResult(historicalArchivedTranscripts);
            }
            if (archivedGeneration.expectedEntryMismatch) {
              return expectedEntryMismatchResult(historicalArchivedTranscripts);
            }
            if (archivedGeneration.deleted) {
              markCommitted();
            }
            // Publish each committed generation immediately: a later archive or
            // transaction failure aborts the deletion, and observers must still see
            // the removals that already happened (retry completes the remainder).
            const publishedGeneration = await publishSessionStateArchives(
              resolved,
              archivedGeneration.archivedTranscripts,
            );
            emitArchivedTranscriptUpdates(publishedGeneration);
            historicalArchivedTranscripts.push(...publishedGeneration);
          }

          // Archive materialization is the expensive phase. It must run between short
          // writer-lane sections so unrelated writes to this store can keep progressing.
          let committedDatabaseIdentity: string | symbol | undefined;
          const result = await runExclusiveSqliteSessionReclamation(async () => {
            const materializedPlans = await materializeSessionStateDeletePlans(prepared.entryPlans);
            const diagnostics: SqliteSessionReclamationDiagnostics = {};
            // The reclamation transaction rereads the exact target immediately before mutation.
            const reclamationPlan = createSessionEntryReclamationPlan({
              databaseOptions,
              deleteParams: params,
              materializedPlans,
              preparedTargetSnapshot: prepared.targetSnapshot,
            });
            const reclaimed = await runSqliteSessionReclamation({
              diagnostics,
              assertCommitAllowed: assertDeletionCurrent,
              forceInProcess:
                typeof params.expectedDatabaseIdentity === "symbol" ||
                hasPreparedNativeSessionDeletion(),
              onInProcessCommit: (database) => {
                committedDatabaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
                recordCommit(database);
              },
              onWorkerResult: (_result, databaseIdentity) => {
                committedDatabaseIdentity = databaseIdentity;
              },
              plan: reclamationPlan,
            });
            if (reclaimed.kind !== reclamationPlan.kind) {
              throw new Error(
                `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
              );
            }
            return reclaimed.value;
          });
          if (result.deleted) {
            markCommitted();
            if (committedDatabaseIdentity === undefined) {
              throw new Error("Committed session deletion omitted its database identity");
            }
            // The deletion is committed; observers must invalidate even if receipt cleanup fails.
            publishCommittedSessionEntryRemoval(
              resolved.agentId,
              committedDatabaseIdentity,
              prepared.current.entry.sessionId,
              prepared.targetSnapshot.map((row) => row.sessionKey),
            );
            await deletePersonalGitHubSessionReceipts({
              agentId: resolved.agentId,
              env: resolved.env,
              ...(execution ? { assertCurrent: () => execution.assertCurrent() } : {}),
              sessionKeys: [
                params.target.canonicalKey,
                ...params.target.storeKeys,
                ...prepared.targetSnapshot.map((row) => row.sessionKey),
              ],
            });
          }
          result.archivedTranscripts = await publishSessionStateArchives(
            resolved,
            result.archivedTranscripts,
          );
          emitArchivedTranscriptUpdates(result.archivedTranscripts);
          // Historical generations were emitted per commit above; merge them into
          // the result after the final emit so callers still see every archive.
          result.archivedTranscripts.push(...historicalArchivedTranscripts);
          return result;
        },
        { additionalIdentities: prepared.historicalGenerationIds },
      );
    });
  } finally {
    await execution?.release();
  }
}

/** Deletes one persisted session entry using SQLite session rows. */
export async function deleteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteSqliteSessionEntryLifecycleInternal(params, false);
}

/** Disk-budget owner: delete one exact archived row without recursively scheduling another pass. */
export async function deleteDiskBudgetSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
  resolved: ResolvedSqliteScope,
): Promise<DeleteSessionEntryLifecycleResult> {
  // A shared store lends its physical owner, not the victim's logical identity.
  // Validate against captured ownership so a custom selector cannot retarget cleanup.
  const targetScope = captureLifecycleDatabaseScope({
    ...resolved,
    agentId: resolveSqliteAgentId({
      scopedAgentId: params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId,
      storeAgentId: resolved.databaseAgentId ?? resolved.agentId,
      storeShared: resolved.databaseAgentId !== undefined,
    }),
  });
  return await withCommittedHistoryMaintenance(
    { ...params, env: targetScope.env },
    async (recordCommit, markCommitted) =>
      await deleteSqliteSessionEntryLifecycleLocked(
        targetScope,
        params,
        false,
        undefined,
        recordCommit,
        markCommitted,
      ),
    { scheduleNext: false },
  );
}

/** Rolls back one exact locked row created by failed trusted harness initialization. */
export async function rollbackAgentHarnessSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & { expectedEntry: SessionEntry },
): Promise<DeleteSessionEntryLifecycleResult> {
  const hasExactTarget =
    params.target.storeKeys.length === 1 &&
    params.target.storeKeys[0] === params.target.canonicalKey;
  const expectedEntryError = resolveAgentHarnessSessionStoreEntryError(
    params.target.canonicalKey,
    params.expectedEntry,
  );
  if (
    !hasExactTarget ||
    expectedEntryError ||
    !isValidAgentHarnessSessionStoreEntry(params.target.canonicalKey, params.expectedEntry)
  ) {
    throw new Error(expectedEntryError ?? MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true);
}

/** Rolls back one exact locked CLI row created by a failed plugin initializer. */
export async function rollbackPluginOwnedSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & {
    expectedEntry: SessionEntry;
    expectedPluginOwnerId: string;
  },
): Promise<DeleteSessionEntryLifecycleResult> {
  const expectedEntry = params.expectedEntry;
  const validPluginOwner = normalizeOptionalString(expectedEntry.pluginOwnerId);
  const expectedPluginOwner = normalizeOptionalString(params.expectedPluginOwnerId);
  if (
    isAgentHarnessSessionKey(params.target.canonicalKey) ||
    expectedEntry.agentHarnessId !== undefined ||
    expectedEntry.modelSelectionLocked !== true ||
    !validPluginOwner ||
    validPluginOwner !== expectedPluginOwner
  ) {
    throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true, expectedPluginOwner);
}
