import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import { createReplySessionInitializationRevision } from "./session-accessor.entry-mutation.js";
import { resolveSessionEntryFromStore } from "./session-accessor.entry.js";
import type {
  SessionEntryLifecycleUpsert,
  SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.lifecycle.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import type { SessionColdArchive } from "./session-accessor.sqlite-archive-types.js";
import { withSessionEntryCreationPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  ReplySessionInitializationSnapshot,
  ReplySessionInitializationCommitContext,
  ReplySessionInitializationCommitResult,
} from "./session-accessor.types.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { assertSessionEntryCohortScope } from "./session-entry-cohort-scope.js";
import type { SessionEntryCreationCommit } from "./session-entry-creation.types.js";
import type { SessionEntryCohortReader } from "./session-entry-read-runtime.types.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  SqliteSessionMutationConflictError,
} from "./session-mutation-conflict-error.js";
import { resolveReplySessionInitializationUpserts } from "./session-reset-entry.js";
import type { ReplySessionInitializationUpsertDescriptor } from "./session-reset.types.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
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

function loadReplySessionInitializationEntriesForMaintenance(
  params: ReplySessionInitializationSelection,
): Record<string, SessionEntry> {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(database.db, () => {
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

async function loadReplySessionInitializationEntriesAsync(
  params: ReplySessionInitializationSelection,
  database: ReturnType<typeof toDatabaseOptions>,
  source?: DatabasePathIdentity,
): Promise<Record<string, SessionEntry>> {
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  const memory = captureMemoryExactSessionReader(params);
  if (memory) {
    const entries: Record<string, SessionEntry> = {};
    const currentKey = normalizeStoreSessionKey(params.sessionKey);
    const keys = new Set([currentKey, ...(params.relatedSessionKeys ?? [])]);
    for (const key of keys) {
      const sessionKey = normalizeStoreSessionKey(key);
      const entry = memory.read(sessionKey);
      if (entry) {
        entries[sessionKey] = entry;
        if (sessionKey === currentKey && entry.parentSessionKey) {
          keys.add(entry.parentSessionKey);
        }
      }
    }
    return entries;
  }
  if (!supportsOpenClawAgentDatabaseExecution(database)) {
    return loadReplySessionInitializationEntriesForMaintenance(params);
  }
  return withSessionHistoryWorkerDatabase(database, async (reader) => {
    const currentKey = normalizeStoreSessionKey(params.sessionKey);
    const snapshot = await reader.readExactEntries({
      projection: "full",
      includeAuthorization: true,
      sessionKeys: [
        ...new Set([
          currentKey,
          ...(params.relatedSessionKeys ?? []).map(normalizeStoreSessionKey),
        ]),
      ],
      replyInitializationSessionKey: currentKey,
      env: { ...(database.env ?? process.env) },
    });
    reader.assertCurrent();
    if (
      source &&
      (snapshot.databaseIdentity
        ? `file:${snapshot.databaseIdentity.identity}` !== source.key ||
          snapshot.databaseIdentity.birthtime !== source.birthtime
        : source.key.startsWith("file:"))
    ) {
      throw new Error("Reply initialization database changed after its snapshot");
    }
    return Object.fromEntries(snapshot.entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
  });
}

function captureReplySessionInitializationSource(
  params: ReplySessionInitializationSelection & { databaseSource?: DatabasePathIdentity },
) {
  const captured = captureLifecycleDatabaseScope(resolveSqliteScope(params));
  const source =
    params.databaseSource ??
    (supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(captured))
      ? readDatabasePathIdentitySync(captured.path)
      : undefined);
  const database = { ...toDatabaseOptions(captured), path: source?.canonicalPath ?? captured.path };
  const assertSourceCurrent = (creating = false) => {
    if (!source) {
      return;
    }
    const current = readDatabasePathIdentitySync(captured.path);
    if (
      current.canonicalPath !== source.canonicalPath ||
      ((!creating || source.key.startsWith("file:")) &&
        (current.key !== source.key || current.birthtime !== source.birthtime))
    ) {
      throw new Error("Reply initialization database changed after its snapshot");
    }
  };
  return { captured, database, source, assertSourceCurrent };
}

/** Prepares data for initialization; the commit owner still rereads and checks its revision. */
export async function loadReplySessionInitializationSnapshot(
  params: ReplySessionInitializationSelection,
  options: {
    reader?: SessionEntryCohortReader;
    includeLifecycle?: boolean;
    includeColdMetadata?: boolean;
    assertCurrent?: () => void;
  } = {},
): Promise<
  ReplySessionInitializationSnapshot & {
    databaseSource?: DatabasePathIdentity;
    lifecycleTimestamps?: SessionLifecycleTimestamps;
    coldArchives?: Array<Omit<SessionColdArchive, "archive_blob">>;
  }
> {
  const { reader, includeLifecycle = false, assertCurrent = () => {} } = options;
  assertSessionInitializationAgentScope(params.agentId, params.sessionKey);
  assertCurrent();
  const storePath = resolveSessionStorePathForScope(params);
  let store: Record<string, SessionEntry>;
  let databaseSource: DatabasePathIdentity | undefined;
  let lifecycleTimestamps: SessionLifecycleTimestamps | undefined;
  let coldArchives: Array<Omit<SessionColdArchive, "archive_blob">> | undefined;
  if (reader) {
    const sessionKey = assertSessionEntryCohortScope(reader, { ...params, storePath });
    const prepared = await reader.withRead(
      {
        sessionKeys: [
          ...new Set([
            sessionKey,
            ...(params.relatedSessionKeys ?? []).map(normalizeStoreSessionKey),
          ]),
        ],
        replyInitializationSessionKey: sessionKey,
        ...(options.includeColdMetadata ? { includeColdMetadata: true } : {}),
        ...(includeLifecycle ? { lifecycleSessionKey: sessionKey } : {}),
      },
      assertCurrent,
      (read) => ({
        store: Object.fromEntries(read.entries.map(({ sessionKey: key, entry }) => [key, entry])),
        lifecycleTimestamps: includeLifecycle ? read.lifecycleTimestamps : undefined,
        coldArchives: read.coldArchives,
      }),
    );
    store = prepared.store;
    lifecycleTimestamps = prepared.lifecycleTimestamps;
    coldArchives = prepared.coldArchives;
  } else {
    const { database, source } = captureReplySessionInitializationSource({
      ...params,
      storePath,
    });
    databaseSource = source;
    store = await loadReplySessionInitializationEntriesAsync(
      { ...params, storePath },
      database,
      source,
    );
  }
  assertCurrent();
  const resolved = resolveSessionEntryFromStore({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  return {
    ...(currentEntry ? { currentEntry } : {}),
    readEntry: (sessionKey) => {
      const entry = resolveSessionEntryFromStore({ store, sessionKey }).existing;
      return entry ? { ...entry } : undefined;
    },
    revision: createReplySessionInitializationRevision(currentEntry),
    ...(databaseSource ? { databaseSource } : {}),
    ...(lifecycleTimestamps ? { lifecycleTimestamps } : {}),
    ...(coldArchives ? { coldArchives } : {}),
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
  /** Keep an authorized creation bound to the database read by its snapshot. */
  databaseSource?: DatabasePathIdentity;
  bindCreation?: (operation: SessionEntryCreationOperation) => () => void;
  onCreated?: (created: SessionEntryCreationCommit) => void;
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
  const { captured, database, source, assertSourceCurrent } =
    captureReplySessionInitializationSource({
      ...params,
      storePath,
    });
  const sessionKey = normalizeStoreSessionKey(params.sessionKey);
  const needsPreparationSnapshot = Boolean(params.prepareSessionEntry || params.bindCreation);
  let store: Record<string, SessionEntry> = {};
  let currentEntry: SessionEntry | undefined;
  let sessionEntry = params.sessionEntry;
  if (needsPreparationSnapshot) {
    // Parent-fork preparation can append transcripts; creation binds live authority.
    // Both need their snapshot before lifecycle planning starts.
    store = await measureDiagnosticsTimelineSpan("reply.session.commit.fresh_read", () =>
      loadReplySessionInitializationEntriesAsync({ ...params, storePath }, database, source),
    );
    currentEntry = store[sessionKey] ? { ...store[sessionKey] } : undefined;
    if (createReplySessionInitializationRevision(currentEntry) !== params.expectedRevision) {
      return createStaleReplySessionInitializationResult(currentEntry);
    }
    if (params.prepareSessionEntry) {
      sessionEntry = await params.prepareSessionEntry({
        ...(currentEntry ? { currentEntry } : {}),
        readEntry: (key) => {
          const entry = resolveSessionEntryFromStore({ store, sessionKey: key }).existing;
          return entry ? { ...entry } : undefined;
        },
        sessionEntry,
      });
    }
  }
  let staleCommit: SessionEntry | null | undefined;
  let usedMemoryBackend = false;
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
  const buildEntry = async (
    commitEntry: SessionEntry | undefined,
    readEntry: (key: string) => SessionEntry | undefined,
  ) => {
    if (!needsPreparationSnapshot) {
      for (const key of [
        sessionKey,
        ...(params.relatedSessionKeys ?? []),
        commitEntry?.parentSessionKey,
      ]) {
        if (!key) {
          continue;
        }
        const entry = readEntry(key);
        if (entry) {
          store[normalizeStoreSessionKey(key)] = entry;
        }
      }
    }
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
  };
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey,
      ...(!needsPreparationSnapshot ? { relatedSessionKeys: params.relatedSessionKeys ?? [] } : {}),
      ...(params.routeContext !== undefined ? { routeContext: params.routeContext } : {}),
      ...(params.resetBoundary ? { resetBoundary: params.resetBoundary } : {}),
      buildEntry: ({ currentEntry: commitEntry, readEntry }) => buildEntry(commitEntry, readEntry),
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
    const mutation = {
      activeSessionKey: params.activeSessionKey,
      agentId: params.agentId,
      skipMaintenance: true,
      storePath,
      upserts,
      commitGuard: () => {
        assertSourceCurrent(true);
        params.commitGuard?.();
      },
    };
    const mutate = async () => {
      const bindCreation = params.bindCreation;
      const assertCurrent = () => params.commitGuard?.();
      const memoryMutation = await withSessionActorStorage(
        { ...params, storePath },
        {
          authority: { assertCurrent, authorize: assertCurrent },
          lifetime: { assertCurrent, assertReadable: assertCurrent },
          create: true,
        },
        async (memory) => {
          const readEntry = (key: string) =>
            memory.actor.storage.readCurrent(
              { type: "session.entry.read", input: { sessionKey: normalizeStoreSessionKey(key) } },
              memory.authority,
            );
          if (!needsPreparationSnapshot) {
            currentEntry = readEntry(sessionKey);
          }
          const nextEntry = await buildEntry(currentEntry, (key) =>
            normalizeStoreSessionKey(key) === sessionKey ? currentEntry : readEntry(key),
          );
          if (!nextEntry) {
            return true;
          }
          const commit = async (assertCreationCurrent?: () => void) => {
            const result = readSessionActorStorageResult(
              await memory.actor.storage.mutate(
                {
                  type: "session.lifecycle.reset",
                  input: {
                    expected: currentEntry,
                    nextEntry,
                    routeContext: params.routeContext,
                    resetBoundary: params.resetBoundary,
                    ...(params.retiredEntry
                      ? {
                          relatedReplacements: [
                            {
                              sessionKey: params.retiredEntry.key,
                              expected: store[params.retiredEntry.key],
                              entry: params.retiredEntry.entry,
                            },
                          ],
                        }
                      : {}),
                  },
                },
                {
                  ...memory.authority,
                  assertCurrent() {
                    memory.authority.assertCurrent();
                    assertCreationCurrent?.();
                  },
                },
              ),
            );
            committedSessionEntry = result.nextEntry;
          };
          if (bindCreation) {
            await withSessionEntryCreationPublication(
              {
                agentId: memory.agentId,
                sessionKey,
                file: {
                  kind: "actor",
                  path: memory.path,
                  agentId: memory.agentId,
                  databaseIdentity: memory.actor.target.database.incarnation,
                  assertCurrent: () => memory.actor.assertCurrent(),
                },
              },
              (operation) => commit(bindCreation(operation)),
            );
          } else {
            await commit();
          }
          return true;
        },
      );
      if (memoryMutation) {
        usedMemoryBackend = true;
        return;
      }
      if (bindCreation) {
        if (currentEntry || !source?.key.startsWith("file:")) {
          throw new Error("The original absent session no longer has its prepared creation source");
        }
        await withSessionEntryCreationPublication(
          {
            agentId: params.agentId,
            sessionKey,
            file: {
              path: database.path,
              agentId: captured.agentId,
              databaseIdentity: source.key.slice("file:".length),
              assertCurrent: assertSourceCurrent,
            },
          },
          async (operation) => {
            const assertCreationCurrent = bindCreation(operation);
            await applySessionEntryLifecycleMutation(
              {
                ...mutation,
                commitGuard: () => {
                  mutation.commitGuard();
                  assertCreationCurrent();
                },
              },
              { ...captured, path: database.path },
            );
            if (staleCommit === undefined) {
              params.onCreated?.({
                agentId: params.agentId,
                sessionKey,
                storePath,
                sessionId: committedSessionEntry.sessionId,
                lifecycleRevision: committedSessionEntry.lifecycleRevision,
                readSource: {
                  agentId: captured.agentId,
                  path: database.path,
                  databaseIdentity: source.key.slice("file:".length),
                  databaseBirthtime: source.birthtime,
                },
                entry: committedSessionEntry,
              });
            }
          },
        );
      } else {
        await applySessionEntryLifecycleMutation(mutation, { ...captured, path: database.path });
      }
    };
    await measureDiagnosticsTimelineSpan("reply.session.commit.mutation", mutate);
  } catch (error) {
    if (
      !(
        error instanceof SqliteSessionMutationConflictError &&
        error.operationLabel === "session.lifecycle.reset"
      ) &&
      (!(error instanceof SessionEntryLifecycleUpsertConflictError) ||
        error.sessionKey !== sessionKey)
    ) {
      throw error;
    }
    const current = await loadReplySessionInitializationEntriesAsync(
      {
        agentId: params.agentId,
        sessionKey,
        storePath,
      },
      database,
      source?.key.startsWith("file:") ? source : undefined,
    );
    return createStaleReplySessionInitializationResult(current[sessionKey]);
  }
  if (staleCommit !== undefined) {
    return createStaleReplySessionInitializationResult(staleCommit ?? undefined);
  }
  if (!usedMemoryBackend) {
    // Reply preparation shares ordinary writes' maintenance owner, never forced cleanup.
    kickSessionEntryMaintenanceAfterWrite({
      activeSessionKey: params.activeSessionKey,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(captured),
      maintenanceConfig: params.maintenanceConfig,
      scope: { ...captured, path: database.path },
      storePath,
    });
  }
  store[sessionKey] = committedSessionEntry;
  if (params.retiredEntry) {
    store[params.retiredEntry.key] = params.retiredEntry.entry;
  }
  return {
    ok: true,
    sessionEntry: { ...committedSessionEntry },
    sessionStoreView: Object.fromEntries(
      Object.entries(store).map(([key, entry]) => [key, { ...entry }]),
    ),
  };
}
