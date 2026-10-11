import { isMainThread } from "node:worker_threads";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { invalidateSessionBranchCache } from "./session-accessor.sqlite-branches.js";
import {
  commitSqliteSessionDeletion,
  runSqliteSessionDeletionTransaction,
  withSqliteSessionContextReset,
} from "./session-accessor.sqlite-deletion.js";
import { retainPreparedSessionSharingFacts } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionBranchSwitchMutationParams,
  SessionBranchSwitchMutationResult,
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import {
  captureIncognitoSessionSource,
  publishIncognitoSessionEntry,
} from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import { planSessionMessageCut } from "./session-message-cut-plan.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutPreconditions,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import {
  markSessionTranscriptIndexDirtyInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "./session-transcript-index.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { collectSessionEntryLookupKeys, normalizeStoreSessionKey } from "./store-entry.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionTranscriptMutationMode = "fork" | "rewind" | "switch";
type SessionEntryExpectedState = Pick<SessionEntry, "lifecycleRevision" | "sessionId">;

export async function rewindSessionToMessage(
  params: SessionMessageCutMutationParams,
  expectedState?: SessionEntryExpectedState,
): Promise<SessionMessageCutMutationResult | { status: "conflict" }> {
  return await mutateSqliteSessionAtMessage(params, "rewind", expectedState);
}

export async function forkSessionAtMessage(
  params: SessionMessageCutMutationParams & { targetKey: string },
  expectedState?: SessionEntryExpectedState,
): Promise<SessionMessageCutMutationResult | { status: "conflict" }> {
  return await mutateSqliteSessionAtMessage(params, "fork", expectedState);
}

/** Gateway-owned source predicates are checked beside the transaction's fresh session row. */
export async function mutateSessionAtMessageWithPreconditions(
  params: SessionMessageCutMutationParams,
  mode: SessionTranscriptMutationMode,
  expectedState: SessionEntryExpectedState | undefined,
  preconditions: SessionMessageCutPreconditions,
): Promise<SessionMessageCutResult> {
  return mutateSqliteSessionAtMessage(params, mode, expectedState, preconditions);
}

export async function switchSessionBranch(
  params: SessionBranchSwitchMutationParams,
  expectedState?: SessionEntryExpectedState,
): Promise<SessionBranchSwitchMutationResult | { status: "conflict" }> {
  return await mutateSqliteSessionAtMessage(
    { ...params, entryId: params.leafEntryId },
    "switch",
    expectedState,
  );
}

function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: "fork" | "rewind",
  expectedState?: SessionEntryExpectedState,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionMessageCutMutationResult | { status: "conflict" }>;
function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: "switch",
  expectedState?: SessionEntryExpectedState,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionBranchSwitchMutationResult | { status: "conflict" }>;
function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: SessionTranscriptMutationMode,
  expectedState?: SessionEntryExpectedState,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionMessageCutResult>;

async function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: SessionTranscriptMutationMode,
  expectedState?: SessionEntryExpectedState,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionMessageCutResult> {
  const canonicalSourceKey = normalizeStoreSessionKey(params.sessionKey);
  const sourceKey = normalizeStoreSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const targetKey =
    mode === "fork" ? normalizeStoreSessionKey(params.targetKey ?? params.sessionKey) : sourceKey;
  const intent: SessionMessageCutIntent = {
    canonicalSourceKey,
    creation: params.creation ? structuredClone(params.creation) : undefined,
    forkWorkspace: params.forkWorkspace ? structuredClone(params.forkWorkspace) : undefined,
    entryId: params.entryId,
    expectedState: expectedState ? { ...expectedState } : undefined,
    mode,
    repositoryWorkspaceId: params.repositoryWorkspaceId,
    sourceKey,
    targetKey,
  };
  const memory = getSessionActorStorageBinding({ ...params, sessionKey: sourceKey });
  if (memory) {
    let authorityError: unknown;
    const outcome = await memory.actor.storage!.mutate(
      {
        type: "session.messageCut",
        input: { intent, sourceRepositoryWorkspaceId: preconditions?.sourceRepositoryWorkspaceId },
      },
      {
        authorize: (stage, facts, publication) =>
          memory.authority.authorize(stage, facts, publication),
        assertCurrent() {
          try {
            memory.authority.assertCurrent();
            params.commitGuard?.();
            preconditions?.assertUpstreamCurrent?.();
          } catch (error) {
            authorityError = error;
            throw error;
          }
        },
      },
    );
    if (outcome.kind === "rolled-back" && authorityError) {
      throw authorityError;
    }
    return readSessionActorStorageResult(outcome);
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  const options = toDatabaseOptions(resolved);
  const binding = isMainThread ? captureIncognitoSessionSource(params) : undefined;
  if (binding && "kind" in binding) {
    binding.assertCurrent();
    return { status: "missing-session" };
  }
  if (binding) {
    const { actor } = binding;
    binding.admissionSignal?.throwIfAborted();
    return actor.sessions.withSharedState(async () => {
      const authority = {
        assertCurrent() {
          actor.assertCurrent();
          params.commitGuard?.();
        },
      };
      const { entry } = await actor.sessions.read(
        authority,
        { sessionKey: sourceKey },
        binding.admissionSignal,
      );
      binding.admissionSignal?.throwIfAborted();
      if (!entry) {
        return { status: "missing-session" };
      }
      intent.expectedState ??= {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      };
      const target = { sessionKey: sourceKey, entry };
      const mutate = async (
        assertResetCurrent: () => void,
        capture?: Parameters<Parameters<typeof withSqliteSessionContextReset>[2]>[1],
      ) => {
        // Preparation can be cancelled; an admitted native write must settle.
        binding.admissionSignal?.throwIfAborted();
        let transactionSessionId: string | undefined;
        let changed = false;
        const current: IncognitoSessionAuthority = {
          assertCurrent() {
            authority.assertCurrent();
            assertResetCurrent();
          },
          authorize(stage, facts) {
            if (facts.sessionKey === sourceKey) {
              if (stage === "transaction") {
                transactionSessionId = facts.sharing?.entry?.sessionId;
              } else {
                changed = facts.sharing?.entry?.sessionId !== transactionSessionId;
              }
            }
          },
        };
        const settlement = capture?.([target]);
        return actor.sessions.lifecycle(
          current,
          {
            type: "session.lifecycle.messageCut",
            input: {
              intent,
              sourceRepositoryWorkspaceId: preconditions?.sourceRepositoryWorkspaceId,
              ...(mode !== "fork" ? { target } : {}),
            },
          },
          undefined,
          settlement
            ? () => ({
                beforeCommit() {
                  if (changed) {
                    settlement.beforeCommit();
                  }
                },
                settle: (outcome) => settlement.settle(outcome),
              })
            : undefined,
          ({ result }) => {
            if (result.status === "created") {
              invalidateSessionBranchCache(actor.path, [entry.sessionId, result.entry.sessionId]);
              publishIncognitoSessionEntry(
                actor,
                result.key,
                mode === "fork" ? undefined : entry,
                result.entry,
              );
            }
          },
        );
      };
      const { result, projectionNeedsReconcile } =
        mode === "fork"
          ? await mutate(() => {})
          : await withSqliteSessionContextReset(
              { ...resolved, path: actor.path },
              target,
              mutate,
              preconditions?.assertUpstreamCurrent,
              actor,
            );
      if (result.status === "created" && projectionNeedsReconcile) {
        startSessionTranscriptIndexReconcile(
          { ...options, path: actor.path, preferredSessionId: result.entry.sessionId },
          {
            actor,
            authority,
            target: {
              sessionKey: result.key,
              sessionId: result.entry.sessionId,
              lifecycleRevision: result.entry.lifecycleRevision,
            },
          },
        );
      }
      return result;
    });
  }
  if (isMainThread && supportsOpenClawAgentDatabaseExecution(options)) {
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const source = readDatabasePathIdentitySync(pathname);
    const env = captureSessionTranscriptStorageEnvironment(resolved.env ?? process.env);
    const selection =
      !intent.expectedState && source.key.startsWith("file:")
        ? retainPreparedSessionSharingFacts({
            databaseIdentity: source.key,
            sessionKey: sourceKey,
            acquiring: true,
          })
        : undefined;
    try {
      const { mutateSessionHistoryInWorker } = await import("./session-message-cut.js");
      return await mutateSessionHistoryInWorker(
        { ...params, env },
        { ...resolved, env, path: pathname },
        { ...intent, mode },
        source,
        (prepared, assertCurrent) =>
          mutatePreparedSqliteSessionAtMessage(
            { ...params, env },
            { ...resolved, env },
            prepared,
            assertCurrent,
            preconditions,
          ),
        selection,
        preconditions,
      );
    } finally {
      selection?.release();
    }
  }
  const preparedEntry = readSessionEntryRow(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    sourceKey,
  )?.entry;
  const preparedExpectedState =
    expectedState ??
    (preparedEntry?.sessionId
      ? {
          sessionId: preparedEntry.sessionId,
          lifecycleRevision: preparedEntry.lifecycleRevision,
        }
      : undefined);
  if (preparedEntry?.sessionId) {
    params.commitGuard?.();
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    await restoreSessionColdTranscript({
      ...params,
      agentId: resolved.agentId,
      sessionId: preparedEntry.sessionId,
    });
  }
  const mutate = (assertPreparedCurrent?: () => void) =>
    mutatePreparedSqliteSessionAtMessage(
      params,
      resolved,
      { ...intent, expectedState: preparedExpectedState },
      assertPreparedCurrent,
      preconditions,
    );
  return mode !== "fork" && preparedEntry
    ? await withSqliteSessionContextReset(
        resolved,
        { sessionKey: sourceKey, entry: preparedEntry },
        mutate,
        preconditions?.assertUpstreamCurrent,
      )
    : await mutate();
}

function mutatePreparedSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  resolved: ResolvedSqliteScope,
  intent: SessionMessageCutIntent,
  assertPreparedCurrent?: () => void,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionMessageCutResult> {
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      let previousIdentity = new Map<string, SessionEntry>();
      const { databasePath, result, publish } = runSqliteSessionDeletionTransaction(
        (database) => {
          assertPreparedCurrent?.();
          params.commitGuard?.();
          preconditions?.assertUpstreamCurrent?.();
          const identityKeys = uniqueStrings([
            ...collectSessionEntryLookupKeys(intent.sourceKey),
            ...collectSessionEntryLookupKeys(intent.targetKey),
          ]);
          previousIdentity = readSessionIdentitySnapshot(database, identityKeys);
          const mutationResult = mutateSqliteSessionAtMessageInTransaction(
            database,
            resolved,
            intent,
            { sourceRepositoryWorkspaceId: preconditions?.sourceRepositoryWorkspaceId },
          );
          const currentIdentity = readSessionIdentitySnapshot(database, identityKeys);
          const publishIdentity = prepareSessionIdentityPublication(
            database,
            resolved.agentId,
            previousIdentity,
            currentIdentity,
          );
          preconditions?.assertUpstreamCurrent?.();
          return {
            databasePath: database.path,
            result: mutationResult,
            publish: publishIdentity,
          };
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.message-cut" },
      );
      if (result.status === "created") {
        invalidateSessionBranchCache(databasePath, [
          ...[...previousIdentity.values()].flatMap((entry) =>
            entry.sessionId ? [entry.sessionId] : [],
          ),
          ...(result.entry.sessionId ? [result.entry.sessionId] : []),
        ]);
      }
      publish();
      return result;
    },
    "session.message-cut.mutate",
  );
}

export function mutateSqliteSessionAtMessageInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: SessionMessageCutIntent,
  projection?: {
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
    sourceRepositoryWorkspaceId?: string;
  },
): SessionMessageCutResult {
  const currentEntry = readSessionEntryRow(database, params.sourceKey)?.entry;
  const plan = planSessionMessageCut(
    currentEntry,
    currentEntry?.sessionId
      ? loadTranscriptEventsFromDatabase(database, currentEntry.sessionId)
      : [],
    params,
    projection?.sourceRepositoryWorkspaceId,
  );
  if (plan.status !== "prepared") {
    return plan;
  }
  if (params.mode !== "fork" && currentEntry) {
    commitSqliteSessionDeletion(params.sourceKey, currentEntry);
  }
  const nextSessionId = plan.result.entry.sessionId;
  const targetScope = { ...resolved, sessionId: nextSessionId, sessionKey: params.targetKey };
  let copiedBytes = 0;
  const rebuildSynchronously =
    params.mode !== "fork" &&
    plan.events.length <= SYNC_REBUILD_MAX_ROWS &&
    plan.events.every((event) => {
      copiedBytes += JSON.stringify(event).length;
      return copiedBytes <= SYNC_REBUILD_MAX_BYTES;
    });
  if (params.mode !== "fork" && !rebuildSynchronously) {
    ensureTranscriptSessionRoot(database, targetScope, Date.parse(plan.header.timestamp));
    markSessionTranscriptIndexDirtyInTransaction(database.db, nextSessionId);
  }
  appendTranscriptEventsInTransaction(database, targetScope, plan.events, projection);
  if (rebuildSynchronously) {
    reconcileSessionTranscriptIndexInTransaction(database.db, nextSessionId);
  } else if (params.mode !== "fork") {
    projection?.onProjectionReconcileNeeded?.();
  }
  writeSessionEntry(database, params.targetKey, plan.result.entry);
  return plan.result;
}
