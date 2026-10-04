import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import {
  cloneSessionEntries,
  createReplySessionInitializationRevision,
} from "./session-accessor.entry-mutation.js";
import { loadSessionEntry, resolveSessionEntryFromStore } from "./session-accessor.entry.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  type SessionEntryLifecycleUpsert,
  type SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  ReplySessionInitializationSnapshot,
  ReplySessionInitializationCommitContext,
  ReplySessionInitializationCommitResult,
} from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { resolveReplySessionInitializationUpserts } from "./session-reset-entry.js";
import type { ReplySessionInitializationUpsertDescriptor } from "./session-reset.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

export class SessionInitializationAgentScopeMismatchError extends Error {
  readonly code = "SESSION_INITIALIZATION_AGENT_SCOPE_MISMATCH";

  constructor(
    readonly agentId: string,
    readonly sessionKeyAgentId: string,
  ) {
    super(
      `Session initialization agent scope mismatch: explicit agent "${agentId}" does not match session key agent "${sessionKeyAgentId}".`,
    );
    this.name = "SessionInitializationAgentScopeMismatchError";
  }
}

function assertSessionInitializationAgentScope(agentId: string, sessionKey: string): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (sessionKeyAgentId && normalizeAgentId(sessionKeyAgentId) !== normalizedAgentId) {
    throw new SessionInitializationAgentScopeMismatchError(normalizedAgentId, sessionKeyAgentId);
  }
}

type ReplySessionInitializationSelection = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  relatedSessionKeys?: readonly string[];
};

function loadReplySessionInitializationEntries(
  params: ReplySessionInitializationSelection,
): Record<string, SessionEntry> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const entries: Record<string, SessionEntry> = {};
        const currentKey = normalizeStoreSessionKey(params.sessionKey);
        const keys = new Set([currentKey, ...(params.relatedSessionKeys ?? [])]);
        // Related rows must share the current row's snapshot, including its stored
        // model parent. Lazy reads after preparation could inherit a different generation.
        for (const key of keys) {
          const sessionKey = normalizeStoreSessionKey(key);
          if (!sessionKey || entries[sessionKey]) {
            continue;
          }
          const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
          if (entry) {
            entries[sessionKey] = entry;
            if (sessionKey === currentKey && entry.parentSessionKey) {
              keys.add(entry.parentSessionKey);
            }
          }
        }
        return entries;
      }),
    toDatabaseOptions(resolveSqliteScope(params)),
  );
  return result.found ? result.value : {};
}

/** Loads the declared reply-session rows without exposing a mutable store. */
export function loadReplySessionInitializationSnapshot(
  params: ReplySessionInitializationSelection,
): ReplySessionInitializationSnapshot {
  const storePath = resolveSessionStorePathForScope(params);
  const store = loadReplySessionInitializationEntries({ ...params, storePath });
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  return {
    ...(currentEntry ? { currentEntry } : {}),
    readEntry: (sessionKey) => {
      const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
      return entry ? { ...entry } : undefined;
    },
    revision: createReplySessionInitializationRevision(currentEntry),
  };
}

function createStaleReplySessionInitializationResult(
  currentEntry: SessionEntry | undefined,
): ReplySessionInitializationCommitResult {
  return {
    ok: false,
    ...(currentEntry ? { currentEntry } : {}),
    reason: "stale-snapshot",
    revision: createReplySessionInitializationRevision(currentEntry),
  };
}

/** Persists one reply-session initialization result with its in-place reset boundary. */
export async function commitReplySessionInitialization(params: {
  commitGuard?: () => void;
  activeSessionKey: string;
  agentId: string;
  beforeEntryMutation?: (context: {
    currentEntry?: SessionEntry;
    sessionEntry: SessionEntry;
  }) => Promise<void> | void;
  expectedRevision: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  prepareSessionEntry?: (
    context: ReplySessionInitializationCommitContext,
  ) => Promise<SessionEntry> | SessionEntry;
  /** Authoritative contextual route facts observed by the admitted inbound turn. */
  routeContext?: ConversationRouteContext | null;
  resetBoundary?: SessionResetBoundaryWrite;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  relatedSessionKeys?: readonly string[];
  snapshotEntry?: SessionEntry;
  storePath: string;
}): Promise<ReplySessionInitializationCommitResult> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const storePath = resolveSessionStorePathForScope({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const store = loadReplySessionInitializationEntries({ ...params, storePath });
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const revision = createReplySessionInitializationRevision(currentEntry);
  if (revision !== params.expectedRevision) {
    return createStaleReplySessionInitializationResult(currentEntry);
  }

  const readEntry = (sessionKey: string) => {
    const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
    return entry ? { ...entry } : undefined;
  };
  const sessionEntry = params.prepareSessionEntry
    ? await params.prepareSessionEntry({
        ...(currentEntry ? { currentEntry } : {}),
        readEntry,
        sessionEntry: params.sessionEntry,
      })
    : params.sessionEntry;
  let staleCommit: SessionEntry | null | undefined;
  let committedSessionEntry = sessionEntry;
  let beforeEntryMutationDone = false;
  const descriptor: ReplySessionInitializationUpsertDescriptor = {
    kind: "reply-initialization",
    expectedRevision: params.expectedRevision,
    entry: sessionEntry,
    snapshotEntry: params.snapshotEntry ?? params.previousEntry,
    retiredEntry: params.retiredEntry,
  };
  let preparedUpserts: ReturnType<typeof resolveReplySessionInitializationUpserts> | undefined;
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey: resolved.normalizedKey,
      ...(params.routeContext !== undefined ? { routeContext: params.routeContext } : {}),
      ...(params.resetBoundary ? { resetBoundary: params.resetBoundary } : {}),
      buildEntry: async ({ currentEntry: commitEntry }) => {
        preparedUpserts = resolveReplySessionInitializationUpserts(descriptor, commitEntry);
        if (preparedUpserts.kind === "stale") {
          staleCommit = preparedUpserts.currentEntry ? { ...preparedUpserts.currentEntry } : null;
          return null;
        }
        committedSessionEntry = preparedUpserts.entry;
        if (!beforeEntryMutationDone) {
          await params.beforeEntryMutation?.({
            ...(commitEntry ? { currentEntry: { ...commitEntry } } : {}),
            sessionEntry: committedSessionEntry,
          });
          beforeEntryMutationDone = true;
        }
        return committedSessionEntry;
      },
    },
  ];
  if (params.retiredEntry) {
    const retiredEntry = params.retiredEntry;
    upserts.push({
      sessionKey: retiredEntry.key,
      buildEntry: () =>
        preparedUpserts?.kind === "ready" ? (preparedUpserts.retiredEntry?.entry ?? null) : null,
    });
  }
  try {
    await applySessionEntryLifecycleMutation({
      activeSessionKey: params.activeSessionKey,
      agentId: params.agentId,
      maintenanceOverride: params.maintenanceConfig,
      storePath,
      upserts,
      commitGuard: params.commitGuard,
    });
  } catch (error) {
    if (
      !(error instanceof SessionEntryLifecycleUpsertConflictError) ||
      error.sessionKey !== resolved.normalizedKey
    ) {
      throw error;
    }
    return createStaleReplySessionInitializationResult(
      loadSessionEntry({
        agentId: params.agentId,
        readConsistency: "latest",
        sessionKey: error.sessionKey,
        storePath,
      }),
    );
  }
  if (staleCommit !== undefined) {
    return createStaleReplySessionInitializationResult(staleCommit ?? undefined);
  }
  store[resolved.normalizedKey] = committedSessionEntry;
  if (params.retiredEntry) {
    store[params.retiredEntry.key] = params.retiredEntry.entry;
  }
  return {
    ok: true,
    previousSessionTranscript: {},
    sessionEntry: { ...committedSessionEntry },
    sessionStoreView: cloneSessionEntries(store),
  };
}
