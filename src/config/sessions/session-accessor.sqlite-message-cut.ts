import { isMainThread } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
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
import {
  getSessionKysely,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import {
  readNextTranscriptSeq,
  rotateTranscriptGenerationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionBranchSwitchMutationParams,
  SessionBranchSwitchMutationResult,
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { prepareMessageCutLocalWorkspace } from "./session-message-cut-local-workspace.js";
import { planInPlaceSessionMessageCut, planSessionMessageCut } from "./session-message-cut-plan.js";
import { refuseInPlaceSessionMessageCut } from "./session-message-cut-preflight.js";
import {
  readSessionMessageCut,
  SESSION_MESSAGE_CUT_MAX_BYTES,
} from "./session-message-cut-read.js";
import {
  createMemorySessionMessageCutReader,
  createSessionMessageCutReader,
} from "./session-message-cut-target.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutPreconditions,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import {
  applySessionTranscriptActivePathRepoint,
  prepareSessionTranscriptActivePathRepoint,
} from "./session-transcript-active-path-repoint.js";
import { loadSessionTranscriptEvents } from "./session-transcript-events.js";
import { withSessionTranscriptHydrationCaller } from "./session-transcript-hydration-caller.js";
import { collectSessionEntryLookupKeys, normalizeStoreSessionKey } from "./store-entry.js";
import {
  captureSessionTranscriptStorageEnvironment,
  captureSessionTranscriptTargetBinding,
} from "./transcript-target-binding.js";
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

export function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: "fork" | "rewind",
  expectedState?: SessionEntryExpectedState,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionMessageCutMutationResult | { status: "conflict" }>;
export function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: "switch",
  expectedState?: SessionEntryExpectedState,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionBranchSwitchMutationResult | { status: "conflict" }>;
export function mutateSqliteSessionAtMessage(
  params: SessionMessageCutMutationParams,
  mode: SessionTranscriptMutationMode,
  expectedState?: SessionEntryExpectedState,
  preconditions?: SessionMessageCutPreconditions,
): Promise<SessionMessageCutResult>;

/** Gateway-owned source predicates are checked beside the transaction's fresh session row. */
export async function mutateSqliteSessionAtMessage(
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
  const memoryScope = { ...params, sessionKey: sourceKey };
  let forkVisibility: SessionEntry["visibility"];
  const assertCurrent = () => {
    params.commitGuard?.();
    preconditions?.assertUpstreamCurrent?.();
  };
  const authority = { assertCurrent, authorize() {} };
  const owner = captureSessionActorStorageOwner(memoryScope, authority);
  if (owner) {
    return (
      (await withSessionActorStorage(
        memoryScope,
        {
          authority,
          lifetime: { assertCurrent, assertReadable: assertCurrent },
        },
        async (memory) => {
          const mutate = async (
            assertResetCurrent = () => {},
            capture?: Parameters<Parameters<typeof withSqliteSessionContextReset>[2]>[1],
          ) => {
            let authorityError: unknown;
            const companions: { settlement?: ReturnType<NonNullable<typeof capture>> } = {};
            const outcome = await memory.actor.storage.mutate(
              {
                type: "session.messageCut",
                input: {
                  intent,
                  sourceRepositoryWorkspaceId: preconditions?.sourceRepositoryWorkspaceId,
                },
              },
              {
                authorize: (stage, facts, publication) =>
                  memory.authority.authorize(stage, facts, publication),
                assertCurrent() {
                  try {
                    memory.authority.assertCurrent();
                    assertResetCurrent();
                    if (mode === "fork") {
                      preconditions?.assertForkVisibilityAllowed?.(forkVisibility);
                    }
                  } catch (error) {
                    authorityError = error;
                    throw error;
                  }
                },
              },
              {
                beforeCommit(receipt) {
                  if (mode === "fork" && receipt.value.status === "created") {
                    // The actor rechecks authority after this observer's await, before install.
                    forkVisibility = receipt.value.entry.visibility;
                  }
                  const entry = receipt.changes.find((change) => change.sessionKey === sourceKey)
                    ?.before?.entry;
                  if (capture && receipt.value.status === "created" && entry) {
                    companions.settlement = capture([{ sessionKey: sourceKey, entry }]);
                    return companions.settlement.beforeCommit();
                  }
                  return undefined;
                },
                settled: (settledOutcome) => companions.settlement?.settle(settledOutcome.kind),
              },
            );
            if (outcome.kind === "rolled-back" && authorityError) {
              throw toErrorObject(
                authorityError,
                "Session message cut authority rejected the operation",
              );
            }
            return readSessionActorStorageResult(outcome);
          };
          if (mode === "fork") {
            return mutate();
          }
          const entry = await memory.actor.storage.read(
            { type: "session.entry.read", input: {} },
            memory.authority,
          );
          if (!entry) {
            return { status: "missing-session" } as const;
          }
          if (entry.worktree) {
            intent.expectedState ??= {
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
            };
            // A memory-resident transcript is already whole in the actor's state,
            // so its own reader validates the cut before the workspace retires.
            const events = await withSessionTranscriptHydrationCaller("history-mutation", () =>
              loadSessionTranscriptEvents({
                ...memoryScope,
                maxEventBytes: SESSION_MESSAGE_CUT_MAX_BYTES,
                agentId: memory.agentId,
                storePath: memory.path,
                sessionId: entry.sessionId,
              }),
            );
            memory.authority.assertCurrent();
            const planned = planInPlaceSessionMessageCut(
              entry,
              createMemorySessionMessageCutReader(events),
              { ...intent, mode },
              preconditions?.sourceRepositoryWorkspaceId,
            );
            if (planned.status !== "prepared") {
              return planned;
            }
          }
          const target = captureSessionTranscriptTargetBinding({
            agentId: memory.agentId,
            storePath: memory.path,
            env: params.env,
          });
          intent.settledLocalWorkspace = await prepareMessageCutLocalWorkspace(
            {
              agentId: memory.agentId,
              sessionKey: sourceKey,
              storePath: memory.path,
              env: target.env,
            },
            entry,
            () => memory.authority.assertCurrent(),
          );
          return withSqliteSessionContextReset(
            {
              agentId: memory.agentId,
              path: memory.path,
              env: target.env,
              ownerStorePath: params.storePath,
            },
            { sessionKey: sourceKey, entry },
            mutate,
            preconditions?.assertUpstreamCurrent,
            owner.owner,
          );
        },
      )) ?? { status: "missing-session" }
    );
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  const options = toDatabaseOptions(resolved);
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
        (prepared, assertPreparedCurrent) =>
          mutatePreparedSqliteSessionAtMessage(
            { ...params, env },
            { ...resolved, env },
            prepared,
            assertPreparedCurrent,
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
  if (mode !== "fork" && preparedEntry) {
    if (preparedEntry.worktree) {
      const refused = refuseInPlaceSessionMessageCut(
        {
          ...params,
          agentId: resolved.agentId,
          sessionKey: sourceKey,
          storePath: resolved.path,
          sessionId: preparedEntry.sessionId,
        },
        preparedEntry,
        { ...intent, mode, expectedState: preparedExpectedState },
        preconditions?.sourceRepositoryWorkspaceId,
      );
      assertCurrent();
      if (refused) {
        return refused;
      }
    }
    intent.settledLocalWorkspace = await prepareMessageCutLocalWorkspace(
      {
        agentId: resolved.agentId,
        sessionKey: sourceKey,
        storePath: resolved.path,
        env: resolved.env,
      },
      preparedEntry,
      assertCurrent,
    );
  }
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
          if (intent.mode === "fork" && mutationResult.status === "created") {
            preconditions?.assertForkVisibilityAllowed?.(mutationResult.entry.visibility);
          }
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
  if (params.mode !== "fork") {
    return installInPlaceSessionMessageCut(
      database,
      resolved,
      { ...params, mode: params.mode },
      currentEntry,
      projection,
    );
  }
  // Fork still copies its prefix, so it streams the retained rows one at a time
  // instead of materializing the transcript in the shared worker heap.
  const source = currentEntry?.sessionId
    ? readSessionMessageCut(database, currentEntry.sessionId, params.entryId)
    : undefined;
  const plan = planSessionMessageCut(
    currentEntry,
    source?.events ?? [],
    params,
    projection?.sourceRepositoryWorkspaceId,
  );
  if (plan.status !== "prepared") {
    return plan;
  }
  const nextSessionId = plan.result.entry.sessionId;
  const targetScope = { ...resolved, sessionId: nextSessionId, sessionKey: params.targetKey };
  appendTranscriptEventsInTransaction(database, targetScope, source!.hydrate(plan.events), projection);
  writeSessionEntry(database, params.targetKey, plan.result.entry);
  return plan.result;
}

/**
 * Rewind and branch switch append one `leaf` control row to the existing
 * transcript, so their cost does not depend on transcript size.
 *
 * Consumers that previously detected the cut through a new session id now see
 * the rotated transcript generation, and stale writers that captured the
 * pre-cut rows fail their own compare-and-swap against the bumped mutation
 * watermark.
 */
function installInPlaceSessionMessageCut(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: SessionMessageCutIntent & { mode: "rewind" | "switch" },
  currentEntry: SessionEntry | undefined,
  projection?: {
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
    sourceRepositoryWorkspaceId?: string;
  },
): SessionMessageCutResult {
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  const sessionId = currentEntry.sessionId;
  const reader = createSessionMessageCutReader(database, sessionId);
  if (!reader) {
    throw new Error(`Session transcript projection is unavailable for ${sessionId}`);
  }
  const plan = planInPlaceSessionMessageCut(
    currentEntry,
    reader,
    params,
    projection?.sourceRepositoryWorkspaceId,
  );
  if (plan.status !== "prepared") {
    return plan;
  }
  commitSqliteSessionDeletion(params.sourceKey, currentEntry);
  rotateTranscriptGenerationInTransaction(database, sessionId);
  // Plan the projection difference against the still-clean projection; the append
  // below marks it dirty, and the repoint publishes the exact replacement rows.
  const repoint = prepareSessionTranscriptActivePathRepoint(
    database.db,
    sessionId,
    plan.leafTargetId,
  );
  const appended = appendTranscriptEventsInTransaction(
    database,
    // An aliased store key owns its transcript rows, so the append must target
    // the persisted owner, not the cut's target key.
    {
      ...resolved,
      sessionId,
      sessionKey: readTranscriptOwnerSessionKey(database, sessionId) ?? params.targetKey,
    },
    [plan.leafEvent],
    projection,
  );
  if (repoint && appended > 0) {
    applySessionTranscriptActivePathRepoint(
      database.db,
      sessionId,
      repoint,
      readNextTranscriptSeq(database, sessionId) - 1,
    );
  } else {
    // The projection was already lagging, or the divergence exceeded its bound.
    // Its reconcile owner publishes the result, as it does for any dirty session.
    projection?.onProjectionReconcileNeeded?.();
  }
  writeSessionEntry(database, params.targetKey, plan.result.entry);
  return plan.result;
}

/** Logical owner of the existing transcript rows, which may be an aliased key. */
function readTranscriptOwnerSessionKey(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId),
  )?.session_key;
}
