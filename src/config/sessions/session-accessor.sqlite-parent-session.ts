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
  type ParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  formatLegacySqliteSessionMarkerForScope,
  formatSqliteSessionReferenceForScope,
  normalizeSqliteSessionKey,
  resolveSqliteScope,
  prepareSqliteScope,
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

// Parent-session fork owner: decision, transcript copy, and child entry commit.

/** Prepare one source snapshot; the creation owner commits its copy with the child entry. */
export async function prepareSessionForkTranscript(params: ForkSessionFromParentTranscriptParams) {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" as const };
  }
  params.commitGuard?.();
  const resolved = await prepareSqliteScope({
    agentId: params.agentId,
    sessionKey: params.parentSessionKey,
    storePath: params.storePath,
  });
  const target = params.targetStorePath
    ? await prepareSqliteScope({ sessionKey: params.sessionKey, storePath: params.targetStorePath })
    : resolved;
  const sourceScope = {
    agentId: resolved.agentId,
    env: resolved.env,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
    sessionId: params.parentEntry.sessionId,
    storePath: resolved.path ?? params.storePath,
  };
  const hydration = prepareSessionTranscriptHydration(sourceScope);
  const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
  const snapshot = await readRestoredSessionTranscript(sourceScope, hydration.read, {
    assertCurrent: params.commitGuard,
  });
  params.commitGuard?.();
  hydration.assertCurrent();
  if (snapshot.kind !== "full") {
    throw new Error("Parent fork requires its complete transcript snapshot");
  }
  const source = resolveParentForkSourceTranscript(snapshot.snapshot.events, params.forkFrom);
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
      sessionFile: formatSqliteSessionReferenceForScope({
        ...target,
        sessionId,
        sessionKey: params.sessionKey,
      }),
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
        runOpenClawAgentWriteTransaction((database) => {
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
        }, toDatabaseOptions(resolved)),
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
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  return await runExclusiveSqliteSessionWrite(
    target,
    async () => {
      const sessionId = params.targetSessionId ?? randomUUID();
      const targetScope = {
        ...target,
        sessionId,
        sessionKey: normalizeSqliteSessionKey(params.sessionKey),
      };
      const sessionFile = formatSqliteSessionReferenceForScope(targetScope);
      runOpenClawAgentWriteTransaction((database) => {
        params.commitGuard?.();
        writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
          parentSessionFile,
          source,
        });
      }, toDatabaseOptions(target));
      return { status: "created", transcript: { sessionFile, sessionId } };
    },
    "session.parent.fork-transcript",
  );
}

/** Forks parent context into a child session entry using SQLite rows only. */
export async function forkSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
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

      if (params.skipForkWhen?.(cloneSessionEntry(base))) {
        const sessionEntry = persistSqliteParentForkSkipPatch({
          commitGuard: params.commitGuard,
          entry: base,
          sessionKey: sessionTarget.canonicalKey,
          patch: params.skipPatch?.(cloneSessionEntry(base)),
          resolved,
        });
        return {
          status: "skipped",
          reason: "existing-entry",
          parentEntry: cloneSessionEntry(parent.entry),
          sessionEntry,
        };
      }

      assertModelSelectionUnlocked(parent.entry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
      return {
        status: "prepared",
        parentEntry: cloneSessionEntry(parent.entry),
        base: cloneSessionEntry(base),
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
      >((writeDatabase) => {
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
        const decision = planParentForkDecision(
          freshParent,
          estimateParentForkPromptTokens(source),
        );
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
              fork.status === "missing-parent"
                ? { status: "missing-parent" }
                : { status: "failed" },
          };
        }
        const patch = params.patch?.({
          decision,
          entry: cloneSessionEntry(freshBase),
          fork: fork.transcript,
          parentEntry: cloneSessionEntry(freshParent),
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
        };
        const previousIdentity = readSessionIdentitySnapshot(writeDatabase, [
          sessionTarget.canonicalKey,
        ]);
        const next = writeSessionEntry(
          writeDatabase,
          sessionTarget.canonicalKey,
          mergeSessionEntry(freshBase, forkIdentityPatch),
          {
            previousEntry: freshBase,
            canonicalPreviousEntry: previousIdentity.get(sessionTarget.canonicalKey) ?? null,
          },
        );
        const currentIdentity = readSessionIdentitySnapshot(writeDatabase, [
          sessionTarget.canonicalKey,
        ]);
        return {
          result: {
            status: "forked",
            decision,
            fork: fork.transcript,
            parentEntry: cloneSessionEntry(freshParent),
            sessionEntry: cloneSessionEntry(next),
          },
          publish: prepareSessionIdentityPublication(
            writeDatabase,
            resolved.agentId,
            previousIdentity,
            currentIdentity,
          ),
        };
      }, toDatabaseOptions(resolved));
      if ("skip" in committed) {
        const { decision, base, parentEntry } = committed.skip;
        const patch = params.decisionSkipPatch?.({
          decision,
          entry: cloneSessionEntry(base),
          parentEntry: cloneSessionEntry(parentEntry),
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
          parentEntry: cloneSessionEntry(parentEntry),
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

function persistSqliteParentForkSkipPatch(params: {
  commitGuard?: () => void;
  entry: SessionEntry;
  sessionKey: string;
  patch: Partial<SessionEntry> | null | undefined;
  resolved: ResolvedSqliteScope;
}): SessionEntry {
  if (!params.patch) {
    return cloneSessionEntry(params.entry);
  }
  const merged = mergeSessionEntry(params.entry, params.patch);
  const next = preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: params.entry,
    sessionKey: params.sessionKey,
  });
  const publish = runOpenClawAgentWriteTransaction((database) => {
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
  }, toDatabaseOptions(params.resolved));
  publish();
  return cloneSessionEntry(next);
}

export async function resolveSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  if (parentSessionId.length === 0) {
    return planParentForkDecision(params.parentEntry);
  }
  const resolved = resolveSqliteStoreScope(params.storePath);
  const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
  return readRestoredSessionTranscript(
    { agentId: resolved.agentId, storePath: params.storePath, sessionId: parentSessionId },
    () => {
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      return planParentForkDecision(
        params.parentEntry,
        estimateParentForkPromptTokens(
          resolveParentForkSourceTranscript(
            loadTranscriptEventsFromDatabase(database, parentSessionId),
          ),
        ),
      );
    },
  );
}

function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    enforceTokenLimit?: boolean;
    maxTokens?: number;
    parentEntry: SessionEntry;
    parentSessionKey: string;
    forkFrom?: "last-completed";
    source?: ParentForkSourceTranscript | null;
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
    sessionKey: normalizeSqliteSessionKey(params.targetSessionKey),
  };
  const parentSessionFile = formatLegacySqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  const sessionFile = formatSqliteSessionReferenceForScope(targetScope);
  writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
    parentSessionFile,
    source,
  });
  return {
    status: "created",
    transcript: {
      sessionFile,
      sessionId,
    },
  };
}

function resolveParentForkLimitDecision(
  params: Pick<
    ForkSessionFromParentTranscriptParams,
    "enforceTokenLimit" | "forkFrom" | "maxTokens" | "parentEntry"
  >,
  source: ParentForkSourceTranscript,
): Extract<SessionParentForkDecision, { status: "skip" }> | undefined {
  if (!params.enforceTokenLimit) {
    return undefined;
  }
  const decision = planParentForkDecision(
    params.parentEntry,
    estimateParentForkPromptTokens(source),
    {
      maxTokens: params.maxTokens,
      preferTranscriptEstimate: params.forkFrom === "last-completed",
    },
  );
  return decision.status === "skip" ? decision : undefined;
}

function writeSqliteForkedChildTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  targetScope: ResolvedTranscriptScope,
  params: {
    parentSessionFile: string;
    source: ParentForkSourceTranscript;
  },
): void {
  appendTranscriptEventsInTransaction(
    database,
    targetScope,
    buildForkedChildTranscriptEvents({
      parentSessionFile: params.parentSessionFile,
      source: params.source,
      targetSessionId: targetScope.sessionId,
    }),
  );
}
