import { isMainThread } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import { collectActiveSessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  createOpenClawAgentDatabaseClaim,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
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
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { readLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { publishCommittedSessionEntryRemoval } from "./session-accessor.sqlite-identity.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  runSessionDeletionPlanning,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation-run.js";
import {
  expectedEntryMismatchResult,
  prepareHistoricalGenerationDeletions,
  prepareReclamationDeleteParams,
  runExclusiveSqliteSessionReclamation,
  resolveSessionReclamationDatabaseOptions,
} from "./session-accessor.sqlite-reclamation.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteAgentId,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import {
  deleteCapturedIncognitoSession,
  deleteIncognitoSessionLifecycle,
} from "./session-incognito-lifecycle-operations.js";
import { resetSessionEntryInWorker } from "./session-reset.js";
import { applySessionResetInDatabase } from "./session-reset.kernel.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

// Single-target lifecycle owner: reset, guarded delete, and trusted rollback.

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

export async function resetSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  const agentId = params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId;
  const resolved = captureLifecycleDatabaseScope(
    resolveSqliteStoreScope(params.storePath, { agentId }),
  );
  const databaseOptions = { ...toDatabaseOptions(resolved), path: resolved.path };
  if (isMainThread && supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
    return withCommittedHistoryMaintenance(
      { agentId: resolved.agentId, env: resolved.env, storePath: params.storePath },
      (_recordCommit, markCommitted) =>
        resetSessionEntryInWorker(params, databaseOptions, resolved.agentId, markCommitted),
    );
  }
  // Process-held incognito and explicit native maintenance retain the same reset contract.
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
            currentEntry: current ? structuredClone(current.entry) : undefined,
            primaryKey: params.target.canonicalKey,
          });
          const mutation: ResetSessionEntryLifecycleMutation = {
            nextEntry: structuredClone(nextEntry),
            ...(current ? { previousEntry: structuredClone(current.entry) } : {}),
            ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
          };
          const databaseIdentity = runOpenClawAgentWriteTransaction(
            (transactionDb) => {
              params.commitGuard?.();
              applySessionResetInDatabase(transactionDb, {
                agentId: resolved.agentId,
                target: params.target,
                prepared: targetSnapshot,
                nextEntry,
                resetBoundary: params.resetBoundary,
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
          const identity = readOpenClawAgentDatabaseIdentity(database);
          const claim = createOpenClawAgentDatabaseClaim(
            database,
            retainAgentDatabase(database.db),
          );
          try {
            await params.afterEntryMutation?.(mutation, {
              env: Object.freeze({ ...resolved.env }),
              source: { agentId: resolved.agentId, path: database.path },
              assertCurrent() {
                claim.assertCurrent();
                if (typeof identity.identity === "string") {
                  assertExistingDatabaseIdentity(
                    database.path,
                    `file:${identity.identity}`,
                    identity.birthtime,
                  );
                }
              },
            });
          } finally {
            claim.release();
          }
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
    resolveSqliteScope({ agentId, env: params.env, sessionKey: "", storePath: params.storePath }),
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
        env: _env,
        expectedDatabaseIdentity: _expectedDatabaseIdentity,
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
        async (assertCurrent, _capture, settleReceipts) => {
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
              env: _generationEnv,
              expectedDatabaseIdentity: _generationIdentity,
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
              const reclamationPlan: SqliteSessionReclamationPlan = {
                databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
                deleteParams: prepareReclamationDeleteParams(generation.deleteParams),
                kind: "historical-generation",
                materializedPlans: materializedGeneration,
                preparedTargetSnapshot: prepared.targetSnapshot,
                protectedSessionIds: [...new Set(checked.value.protectedSessionIds)],
                sessionId,
              };
              const reclaimed = await runSqliteSessionReclamation({
                diagnostics,
                assertCommitAllowed: assertDeletionCurrent,
                forceInProcess: typeof params.expectedDatabaseIdentity === "symbol",
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
            const reclamationPlan: SqliteSessionReclamationPlan = {
              databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
              deleteParams: prepareReclamationDeleteParams(params),
              kind: "entry",
              materializedPlans,
              preparedTargetSnapshot: prepared.targetSnapshot,
            };
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
            await settleReceipts(execution ? () => execution.assertCurrent() : undefined);
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
        {
          additionalIdentities: prepared.historicalGenerationIds,
          receiptsOnCommit: {
            generations: [
              ...new Set([
                params.target.canonicalKey,
                ...params.target.storeKeys,
                ...prepared.targetSnapshot.map((row) => row.sessionKey),
              ]),
            ].map((sessionKey) => {
              const entry =
                prepared.targetSnapshot.find((row) => row.sessionKey === sessionKey)?.entry ??
                prepared.current.entry;
              return {
                agentId: resolved.agentId,
                sessionKey,
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision ?? null,
              };
            }),
          },
        },
      );
    });
  } finally {
    await execution?.release();
  }
}

function deleteMemorySessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
  allowLocked = false,
): Promise<DeleteSessionEntryLifecycleResult> | undefined {
  const memory = getSessionActorStorageBinding({
    ...params,
    sessionKey: params.target.canonicalKey,
  });
  if (!memory) {
    return undefined;
  }
  let authorityError: unknown;
  return memory.actor
    .storage!.mutate(
      {
        type: "session.lifecycle.delete",
        input: {
          expectedEntry: params.expectedEntry,
          expectedSessionId: params.expectedSessionId,
          expectedLifecycleRevision: params.expectedLifecycleRevision,
          expectedUpdatedAt: params.expectedUpdatedAt,
        },
      },
      {
        assertCurrent() {
          try {
            memory.authority.assertCurrent();
            params.commitGuard?.();
          } catch (error) {
            authorityError = error;
            throw error;
          }
        },
        authorize(stage, facts, publication) {
          memory.authority.authorize(stage, facts, publication);
          if (!allowLocked && facts.entry) {
            assertModelSelectionUnlocked(facts.entry, MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
          }
        },
      },
    )
    .then((outcome) => {
      if (outcome.kind === "rolled-back" && authorityError) {
        throw toErrorObject(authorityError, "Session deletion authority rejected the operation");
      }
      return readSessionActorStorageResult(outcome);
    });
}

export async function deleteSessionEntryLifecycle(
  params:
    | DeleteSessionEntryLifecycleParams
    | ({ kind: "incognito" } & Parameters<typeof deleteIncognitoSessionLifecycle>[0]),
): Promise<DeleteSessionEntryLifecycleResult> {
  if ("kind" in params) {
    return deleteIncognitoSessionLifecycle(params);
  }
  return (
    deleteMemorySessionEntryLifecycle(params) ??
    deleteCapturedIncognitoSession(params) ??
    deleteSqliteSessionEntryLifecycleInternal(params, false)
  );
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
  return (
    deleteMemorySessionEntryLifecycle(params, true) ??
    deleteCapturedIncognitoSession(params, undefined, params.expectedEntry.agentHarnessId) ??
    deleteSqliteSessionEntryLifecycleInternal(params, true)
  );
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
  return (
    deleteMemorySessionEntryLifecycle(params, true) ??
    deleteCapturedIncognitoSession(params, expectedPluginOwner) ??
    deleteSqliteSessionEntryLifecycleInternal(params, true, expectedPluginOwner)
  );
}
