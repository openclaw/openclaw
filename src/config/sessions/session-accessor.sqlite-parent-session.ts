import { randomUUID } from "node:crypto";
import {
  assertModelSelectionUnlocked,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../../sessions/model-overrides.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { forkCliSessionBindings } from "./cli-session-binding.js";
import type {
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  SessionParentForkDecision,
} from "./session-accessor.sqlite-contract.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  normalizeLifecycleTarget,
  readSessionIdentitySnapshot,
  resolveLifecyclePrimaryEntry,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import {
  buildForkedChildTranscriptEvents,
  estimateParentForkPromptTokens,
  planParentForkDecision,
  resolveParentForkSourceTranscript,
  resolveParentForkLimitDecision,
  type ParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  formatLegacySqliteSessionMarkerForScope,
  resolveSqliteScope,
  prepareSqliteScope,
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  withSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import {
  forkMemorySessionEntryFromParent,
  readMemoryParentForkSource,
} from "./session-parent-fork-memory.js";
import {
  forkParentEntryInWorker,
  forkParentTranscriptInWorker,
  supportsParentForkWorker,
} from "./session-parent-fork.js";
import type { ParentForkEntryPatch, ParentForkEntryParams } from "./session-parent-fork.types.js";
import { loadTranscriptEvents } from "./session-transcript-events.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

// Parent-session fork owner: decision, transcript copy, and child entry commit.

/** Prepare one source snapshot; the creation owner commits its copy with the child entry. */
export async function prepareSessionForkTranscript(
  input: ForkSessionFromParentTranscriptParams & { sessionActor?: SessionActorStorageBinding },
): Promise<
  | { status: "missing-parent" }
  | { status: "failed" }
  | { status: "too-large"; decision: Extract<SessionParentForkDecision, { status: "skip" }> }
  | {
      status: "prepared";
      transcript: { sessionId: string; sessionFile: string };
      events: ReturnType<typeof buildForkedChildTranscriptEvents>;
    }
> {
  const memory = getSessionActorStorageBinding({ sessionActor: input.sessionActor });
  const assertCurrent = () => input.commitGuard?.();
  const authority = { assertCurrent, authorize() {} };
  const scope = { ...input, sessionKey: input.parentSessionKey };
  if (!memory && captureSessionActorStorageOwner(scope, authority)) {
    return (
      (await withSessionActorStorage(
        scope,
        {
          authority,
          lifetime: { assertCurrent, assertReadable: assertCurrent },
        },
        (selected) => prepareSessionForkTranscript({ ...input, sessionActor: selected }),
      )) ?? { status: "missing-parent" as const }
    );
  }
  if (!input.parentEntry.sessionId) {
    return { status: "missing-parent" as const };
  }
  const { commitGuard, sessionActor: _sessionActor, ...data } = input;
  const params = { ...structuredClone(data), commitGuard };
  params.commitGuard?.();
  const memorySource = memory ? await readMemoryParentForkSource(params, memory) : undefined;
  if (memory && !memorySource) {
    return { status: "missing-parent" as const };
  }
  const resolved =
    memorySource?.scope ??
    (await prepareSqliteScope({
      agentId: params.agentId,
      sessionKey: params.parentSessionKey,
      storePath: params.storePath,
    }));
  const sourceScope = {
    ...resolved,
    sessionKey: normalizeStoreSessionKey(params.parentSessionKey),
    sessionId: params.parentEntry.sessionId,
    storePath: resolved.path ?? params.storePath,
  };
  let source: ParentForkSourceTranscript | null;
  if (memorySource) {
    source = memorySource.source;
  } else {
    if (params.targetStorePath) {
      await prepareSqliteScope({
        sessionKey: params.sessionKey,
        storePath: params.targetStorePath,
      });
    }
    const hydration = prepareSessionTranscriptHydration(sourceScope);
    const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
    const snapshot = await readRestoredSessionTranscript(sourceScope, hydration.read, {
      assertCurrent: params.commitGuard,
    });
    hydration.assertCurrent();
    if (snapshot.kind !== "full") {
      throw new Error("Parent fork requires its complete transcript snapshot");
    }
    source = resolveParentForkSourceTranscript(snapshot.snapshot.events, params.forkFrom);
  }
  params.commitGuard?.();
  if (!source) {
    return { status: "failed" as const };
  }
  const decision = resolveParentForkLimitDecision(params, source);
  if (decision) {
    return { status: "too-large" as const, decision };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  return {
    status: "prepared" as const,
    transcript: {
      sessionId,
      sessionFile: params.sessionKey,
    },
    events: buildForkedChildTranscriptEvents({
      parentSessionFile: formatLegacySqliteSessionMarkerForScope({ ...resolved, ...sourceScope }),
      source,
      targetSessionId: sessionId,
    }),
  };
}

export async function forkSessionTranscriptFromParent(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  const assertCurrent = () => params.commitGuard?.();
  const authority = { assertCurrent, authorize() {} };
  const scope = { ...params, sessionKey: params.parentSessionKey };
  if (captureSessionActorStorageOwner(scope, authority)) {
    const prepared = await prepareSessionForkTranscript(params);
    if (prepared.status !== "prepared") {
      return prepared;
    }
    const target = {
      sessionKey: params.sessionKey,
      storePath: params.targetStorePath ?? params.storePath,
    };
    return (
      (await withSessionActorStorage(
        target,
        {
          authority,
          lifetime: { assertCurrent, assertReadable: assertCurrent },
          create: true,
        },
        async (memory) =>
          readSessionActorStorageResult(
            await memory.actor.storage.mutate(
              {
                type: "session.parentFork.transcript",
                input: { sessionId: prepared.transcript.sessionId, events: prepared.events },
              },
              memory.authority,
            ),
          ),
      )) ?? { status: "failed" }
    );
  }
  if (
    supportsParentForkWorker(params) &&
    (!params.targetStorePath ||
      supportsParentForkWorker({
        sessionKey: params.sessionKey,
        storePath: params.targetStorePath,
      }))
  ) {
    return forkParentTranscriptInWorker(params);
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const target = params.targetStorePath
    ? resolveSqliteScope({ sessionKey: params.sessionKey, storePath: params.targetStorePath })
    : resolved;
  const crossDatabase =
    target.agentId !== resolved.agentId || (target.path ?? "") !== (resolved.path ?? "");
  // Explicit maintenance retains the synchronous durable path.
  if (params.parentEntry.sessionId) {
    params.commitGuard?.();
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    await restoreSessionColdTranscript({
      agentId: resolved.agentId,
      env: resolved.env,
      storePath: params.storePath,
      sessionId: params.parentEntry.sessionId,
    });
  }
  if (!crossDatabase) {
    return await runExclusiveSqliteSessionWrite(
      resolved,
      async () =>
        runOpenClawAgentWriteTransaction(
          (database) => {
            params.commitGuard?.();
            return forkSqliteParentTranscriptInTransaction(database, resolved, {
              enforceTokenLimit: params.enforceTokenLimit,
              maxTokens: params.maxTokens,
              parentEntry: params.parentEntry,
              parentSessionKey: params.parentSessionKey,
              forkFrom: params.forkFrom,
              targetSessionId: params.targetSessionId,
              targetSessionKey: params.sessionKey,
            });
          },
          toDatabaseOptions(resolved),
          { operationLabel: "session.parent-fork.same-store" },
        ),
      "session.parent.fork-transcript",
    );
  }
  // Cross-agent fork (worktree/cross-agent sessions.create): parent rows live
  // in the source agent database while the child transcript must be owned by
  // the target agent's database. Two databases cannot share one transaction,
  // so read the parent branch first, then write the child under the target's
  // exclusive target-database writer queue.
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const sourceDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const source = resolveParentForkSourceTranscript(
    loadTranscriptEventsFromDatabase(sourceDatabase, params.parentEntry.sessionId),
    params.forkFrom,
  );
  if (!source) {
    return { status: "failed" };
  }
  const limitDecision = resolveParentForkLimitDecision(params, source);
  if (limitDecision) {
    return { status: "too-large", decision: limitDecision };
  }
  const parentSessionFile = formatLegacySqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeStoreSessionKey(params.parentSessionKey),
  });
  return await runExclusiveSqliteSessionWrite(
    target,
    async () => {
      const sessionId = params.targetSessionId ?? randomUUID();
      const targetScope = {
        ...target,
        sessionId,
        sessionKey: normalizeStoreSessionKey(params.sessionKey),
      };
      runOpenClawAgentWriteTransaction(
        (database) => {
          params.commitGuard?.();
          appendTranscriptEventsInTransaction(
            database,
            targetScope,
            buildForkedChildTranscriptEvents({
              parentSessionFile,
              source,
              targetSessionId: sessionId,
            }),
          );
        },
        toDatabaseOptions(target),
        { operationLabel: "session.parent-fork.copy-transcript" },
      );
      return { status: "created", transcript: { sessionFile: targetScope.sessionKey, sessionId } };
    },
    "session.parent.fork-transcript",
  );
}

/** Forks parent context into a child session entry using SQLite rows only. */
export async function forkSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const memory = forkMemorySessionEntryFromParent(params);
  if (memory) {
    return memory;
  }
  if (
    !params.patch &&
    !params.skipPatch &&
    !params.skipForkWhen &&
    !params.decisionSkipPatch &&
    supportsParentForkWorker({ ...params, sessionKey: "" })
  ) {
    return forkParentEntryInWorker(params);
  }
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  // Opaque released callbacks retain their transaction-local synchronous contract.
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  const prepared = await runExclusiveSqliteSessionWrite<
    | ForkSessionEntryFromParentTargetResult
    | {
        status: "prepared";
        parentEntry: SessionEntry;
        base: SessionEntry;
      }
  >(
    resolved,
    async () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      const parent = resolveLifecyclePrimaryEntry(database, parentTarget);
      if (!parent?.entry.sessionId) {
        return { status: "missing-parent" };
      }

      const existing = resolveLifecyclePrimaryEntry(database, sessionTarget);
      const base = existing?.entry ?? params.fallbackEntry;
      if (!base) {
        return { status: "missing-entry" };
      }

      if (params.skipForkWhen?.(structuredClone(base))) {
        const sessionEntry = persistSqliteParentForkSkipPatch({
          commitGuard: params.commitGuard,
          entry: base,
          sessionKey: sessionTarget.canonicalKey,
          patch: params.skipPatch?.(structuredClone(base)),
          resolved,
        });
        return {
          status: "skipped",
          reason: "existing-entry",
          parentEntry: parent.entry,
          sessionEntry,
        };
      }

      assertModelSelectionUnlocked(parent.entry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
      return {
        status: "prepared",
        parentEntry: parent.entry,
        base: existing ? base : structuredClone(base),
      };
    },
    "session.parent.fork-entry",
  );
  if (prepared.status !== "prepared") {
    return prepared;
  }
  params.commitGuard?.();
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript({
    agentId: resolved.agentId,
    env: resolved.env,
    storePath: params.storePath,
    sessionId: prepared.parentEntry.sessionId,
  });
  // Backend normalization may load plugins. Prepare before BEGIN; the commit
  // below rejects this plan if either authoritative session row changed.
  const { cliBackendSupportsSessionFork } = await import("../../agents/cli-backends.js");
  const cliSessionBindings = forkCliSessionBindings(
    prepared.parentEntry,
    cliBackendSupportsSessionFork,
  );
  return await runExclusiveSqliteSessionWrite<ForkSessionEntryFromParentTargetResult>(
    resolved,
    async () => {
      params.commitGuard?.();
      const committed = runOpenClawAgentWriteTransaction<
        | { result: ForkSessionEntryFromParentTargetResult; publish?: () => void }
        | {
            skip: {
              decision: Extract<SessionParentForkDecision, { status: "skip" }>;
              base: SessionEntry;
              parentEntry: SessionEntry;
            };
          }
      >(
        (writeDatabase) => {
          return forkSessionEntryInTransaction(
            writeDatabase,
            resolved,
            params,
            prepared,
            cliSessionBindings,
          );
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.parent-fork.entry" },
      );
      if ("skip" in committed) {
        const { decision, base, parentEntry } = committed.skip;
        const patch = params.decisionSkipPatch?.({
          decision,
          entry: structuredClone(base),
          parentEntry: structuredClone(parentEntry),
        });
        const sessionEntry = persistSqliteParentForkSkipPatch({
          commitGuard: params.commitGuard,
          entry: base,
          sessionKey: sessionTarget.canonicalKey,
          patch,
          resolved,
        });
        return {
          status: "skipped",
          reason: "decision-skip",
          parentEntry,
          sessionEntry,
          decision,
        };
      }
      committed.publish?.();
      return committed.result;
    },
    "session.parent.fork-entry",
  );
}

export async function forkSessionEntryFromParentTargetWithPatch(
  params: ParentForkEntryParams & { commitGuard?: () => void },
  patch?: ParentForkEntryPatch,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const memory = forkMemorySessionEntryFromParent(params, patch);
  if (memory) {
    return memory;
  }
  if (supportsParentForkWorker({ ...params, sessionKey: "" })) {
    return forkParentEntryInWorker(params, patch);
  }
  return forkSessionEntryFromParentTarget({
    ...params,
    skipForkWhen: patch?.skipExisting ? (entry) => Boolean(entry.sessionId?.trim()) : undefined,
    skipPatch: patch?.skipped ? () => patch.skipped ?? null : undefined,
    patch: patch?.forked ? () => patch.forked ?? {} : undefined,
  });
}

export function forkSessionEntryInTransaction(
  writeDatabase: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: ForkSessionEntryFromParentTargetParams,
  prepared: { parentEntry: SessionEntry; base: SessionEntry },
  cliSessionBindings: SessionEntry["cliSessionBindings"],
):
  | { result: ForkSessionEntryFromParentTargetResult; publish?: () => void }
  | {
      skip: {
        decision: Extract<SessionParentForkDecision, { status: "skip" }>;
        base: SessionEntry;
        parentEntry: SessionEntry;
      };
    } {
  const parentTarget = normalizeLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeLifecycleTarget(params.sessionTarget);
  // Parent authority can close while this fork waits behind another writer.
  params.commitGuard?.();
  const freshParent = resolveLifecyclePrimaryEntry(writeDatabase, parentTarget)?.entry;
  const freshExisting = resolveLifecyclePrimaryEntry(writeDatabase, sessionTarget);
  const freshBase = freshExisting?.entry ?? params.fallbackEntry;
  if (
    !freshParent ||
    !freshBase ||
    !sqliteSessionEntriesEqual(freshParent, prepared.parentEntry) ||
    !sqliteSessionEntriesEqual(freshBase, prepared.base)
  ) {
    return { result: { status: "failed" } };
  }
  assertModelSelectionUnlocked(freshParent, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  const source = resolveParentForkSourceTranscript(
    loadTranscriptEventsFromDatabase(writeDatabase, freshParent.sessionId),
  );
  const decision = planParentForkDecision(freshParent, estimateParentForkPromptTokens(source));
  if (decision.status === "skip") {
    return { skip: { decision, base: freshBase, parentEntry: freshParent } };
  }
  const fork = forkSqliteParentTranscriptInTransaction(writeDatabase, resolved, {
    parentEntry: freshParent,
    parentSessionKey: parentTarget.canonicalKey,
    source,
    targetSessionKey: sessionTarget.canonicalKey,
  });
  if (fork.status !== "created") {
    return {
      result:
        fork.status === "missing-parent" ? { status: "missing-parent" } : { status: "failed" },
    };
  }
  const patch = params.patch?.({
    decision,
    entry: structuredClone(freshBase),
    fork: fork.transcript,
    parentEntry: structuredClone(freshParent),
  });
  const forkIdentityPatch: Partial<InternalSessionEntry> = {
    ...patch,
    forkSource: {
      sessionKey: parentTarget.canonicalKey,
      sessionId: freshParent.sessionId,
    },
    forkedFromParent: true,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    sessionId: fork.transcript.sessionId,
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
    cliSessionBindings,
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
  };
  const previousIdentity = readSessionIdentitySnapshot(writeDatabase, [sessionTarget.canonicalKey]);
  const next = writeSessionEntry(
    writeDatabase,
    sessionTarget.canonicalKey,
    mergeSessionEntry(freshBase, forkIdentityPatch),
    {
      previousEntry: freshBase,
      canonicalPreviousEntry: previousIdentity.get(sessionTarget.canonicalKey) ?? null,
    },
  );
  const currentIdentity = readSessionIdentitySnapshot(writeDatabase, [sessionTarget.canonicalKey]);
  return {
    result: {
      status: "forked",
      decision,
      fork: fork.transcript,
      parentEntry: freshParent,
      sessionEntry: structuredClone(next),
    },
    publish: prepareSessionIdentityPublication(
      writeDatabase,
      resolved.agentId,
      previousIdentity,
      currentIdentity,
    ),
  };
}

function persistSqliteParentForkSkipPatch(params: {
  commitGuard?: () => void;
  entry: SessionEntry;
  sessionKey: string;
  patch: Partial<SessionEntry> | null | undefined;
  resolved: ResolvedSqliteScope;
}): SessionEntry {
  if (!params.patch) {
    return structuredClone(params.entry);
  }
  const merged = mergeSessionEntry(params.entry, params.patch);
  const next = preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: params.entry,
    sessionKey: params.sessionKey,
  });
  const publish = runOpenClawAgentWriteTransaction(
    (database) => {
      params.commitGuard?.();
      const previousIdentity = readSessionIdentitySnapshot(database, [params.sessionKey]);
      writeSessionEntry(database, params.sessionKey, next, {
        previousEntry: params.entry,
        canonicalPreviousEntry: previousIdentity.get(params.sessionKey) ?? null,
      });
      const currentIdentity = readSessionIdentitySnapshot(database, [params.sessionKey]);
      return prepareSessionIdentityPublication(
        database,
        params.resolved.agentId,
        previousIdentity,
        currentIdentity,
      );
    },
    toDatabaseOptions(params.resolved),
    { operationLabel: "session.parent-fork.skip" },
  );
  publish();
  return structuredClone(next);
}

export async function resolveSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  parentSessionKey?: string;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  if (parentSessionId.length === 0) {
    return planParentForkDecision(params.parentEntry);
  }
  const parentEntry = structuredClone(params.parentEntry);
  const authority = { assertCurrent() {}, authorize() {} };
  const scope = { ...params, sessionKey: params.parentSessionKey, sessionId: parentSessionId };
  const captured = captureSessionActorStorageOwner(scope, authority);
  const source = captured
    ? ((await withSessionActorStorage(
        scope,
        {
          authority,
          lifetime: {
            assertCurrent: authority.assertCurrent,
            assertReadable: authority.assertCurrent,
          },
        },
        (memory) =>
          memory.actor.storage.read(
            {
              type: "session.parentFork.source",
              input: { sessionId: parentSessionId },
            },
            memory.authority,
          ),
      )) ?? null)
    : resolveParentForkSourceTranscript(
        await loadTranscriptEvents({ storePath: params.storePath, sessionId: parentSessionId }),
      );
  return planParentForkDecision(parentEntry, estimateParentForkPromptTokens(source));
}

export function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    enforceTokenLimit?: boolean;
    maxTokens?: number;
    parentEntry: SessionEntry;
    parentSessionKey: string;
    forkFrom?: "last-completed";
    source?: ParentForkSourceTranscript | null;
    parentSessionFile?: string;
    targetSessionId?: string;
    targetSessionKey: string;
  },
): ForkSessionFromParentTranscriptResult {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const source =
    params.source === undefined
      ? resolveParentForkSourceTranscript(
          loadTranscriptEventsFromDatabase(database, params.parentEntry.sessionId),
          params.forkFrom,
        )
      : params.source;
  if (!source) {
    return { status: "failed" };
  }
  const limitDecision = resolveParentForkLimitDecision(params, source);
  if (limitDecision) {
    return { status: "too-large", decision: limitDecision };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: normalizeStoreSessionKey(params.targetSessionKey),
  };
  const parentSessionFile =
    params.parentSessionFile ??
    formatLegacySqliteSessionMarkerForScope({
      ...resolved,
      sessionId: params.parentEntry.sessionId,
      sessionKey: normalizeStoreSessionKey(params.parentSessionKey),
    });
  appendTranscriptEventsInTransaction(
    database,
    targetScope,
    buildForkedChildTranscriptEvents({ parentSessionFile, source, targetSessionId: sessionId }),
  );
  return {
    status: "created",
    transcript: {
      sessionFile: targetScope.sessionKey,
      sessionId,
    },
  };
}
