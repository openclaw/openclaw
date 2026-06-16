import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import type { Selectable } from "kysely";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { redactSecrets } from "../../logging/redact.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type {
  ExactSessionEntry,
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntrySummary,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionEntryUpdateOptions,
  SessionTranscriptAccessScope,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
  TranscriptUpdatePayload,
} from "./session-accessor.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
} from "./store-maintenance.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry, mergeSessionEntryPreserveActivity } from "./types.js";

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "conversations"
  | "session_conversations"
  | "session_entries"
  | "session_routes"
  | "sessions"
  | "transcript_event_identities"
  | "transcript_events"
>;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_entries"]>;
type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  legacyKeys: string[];
  row: SessionEntryRow;
};
type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  skipMaintenance?: boolean;
};

type ResolvedSqliteScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey: string;
};

type ResolvedSqliteReadScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey?: string;
};

type ResolvedTranscriptScope = ResolvedSqliteScope & {
  sessionId: string;
};

type ResolvedTranscriptReadScope = ResolvedSqliteReadScope & {
  sessionId: string;
};

type ResolvedSqliteStoreTarget = {
  agentId?: string;
  path?: string;
};

const SQLITE_SESSION_WRITER_QUEUES = new Map<string, StoreWriterQueue>();

/** Loads one session entry from the additive SQLite session store. */
export function loadSqliteSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSessionEntryRow(database, resolved.sessionKey)?.entry;
}

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSqliteSessionEntry(
  scope: SessionAccessScope,
): ExactSessionEntry | undefined {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readExactSessionEntryRow(database, sessionKey);
  return row ? { sessionKey, entry: row.entry } : undefined;
}

/** Lists session entries from the additive SQLite session store. */
export function listSqliteSessionEntries(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "entry_json", "session_id", "updated_at"])
      .orderBy("session_key", "asc"),
  ).rows;
  return rows
    .map((row) => {
      const entry = parseSessionEntryRow(row);
      return entry ? { sessionKey: row.session_key, entry } : undefined;
    })
    .filter((entry): entry is SessionEntrySummary => entry !== undefined);
}

/** Reads a session activity timestamp from the additive SQLite session store. */
export function readSqliteSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readSessionEntryRow(database, resolved.sessionKey)?.row;
  return row ? normalizeSqliteNumber(row.updated_at) : undefined;
}

/** Applies a partial entry update to the additive SQLite session store. */
export async function upsertSqliteSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => patch, {
    fallbackEntry: createFallbackSessionEntry(patch),
  });
}

/** Replaces one entry in the additive SQLite session store. */
export async function replaceSqliteSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
  });
}

/** Patches one entry in the additive SQLite session store. */
export async function patchSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const existing = readSessionEntryRow(database, resolved.sessionKey)?.entry;
    const base = existing ?? options.fallbackEntry;
    if (!base) {
      return null;
    }
    const patch = await update(cloneSessionEntry(base), {
      existingEntry: existing ? cloneSessionEntry(existing) : undefined,
    });
    if (!patch) {
      return cloneSessionEntry(base);
    }

    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSessionEntryRow(writeDatabase, resolved.sessionKey);
      const writeBase = fresh?.entry ?? options.fallbackEntry;
      if (!writeBase) {
        result = null;
        return;
      }
      const next = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(writeDatabase, fresh?.legacyKeys ?? [], resolved.sessionKey);
      applySqliteSessionEntryMaintenance(writeDatabase, {
        activeSessionKey: resolved.sessionKey,
        skipMaintenance: options.skipMaintenance,
      });
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Updates an existing entry in the additive SQLite session store. */
export async function updateSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const existing = readSessionEntryRow(database, resolved.sessionKey)?.entry;
    if (!existing) {
      return null;
    }
    const patch = await update(cloneSessionEntry(existing));
    if (!patch) {
      return cloneSessionEntry(existing);
    }

    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSessionEntryRow(writeDatabase, resolved.sessionKey);
      if (!fresh) {
        result = null;
        return;
      }
      const next = mergeSessionEntry(fresh.entry, patch);
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(writeDatabase, fresh.legacyKeys, resolved.sessionKey);
      applySqliteSessionEntryMaintenance(writeDatabase, {
        activeSessionKey: resolved.sessionKey,
        skipMaintenance: options.skipMaintenance,
      });
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Cleans scoped session lifecycle rows and associated SQLite transcript state. */
export async function cleanupSqliteSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }

  const resolved = resolveSqliteReadScope({ storePath: params.storePath });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: SessionLifecycleArtifactCleanupResult = {
      removedEntries: 0,
      archivedTranscriptArtifacts: 0,
    };
    runOpenClawAgentWriteTransaction((database) => {
      result = cleanupSqliteSessionLifecycleArtifactsInTransaction(database, {
        sessionKeySegmentPrefix,
        transcriptContentMarker,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        nowMs: params.nowMs ?? Date.now(),
      });
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Loads raw transcript events from the additive SQLite transcript store. */
export async function loadSqliteTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return loadSqliteTranscriptEventsSync(scope);
}

/** Loads raw transcript events synchronously from the additive SQLite transcript store. */
export function loadSqliteTranscriptEventsSync(
  scope: SessionTranscriptReadScope,
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", resolved.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
}

/** Appends one raw transcript event to the additive SQLite transcript store. */
export async function appendSqliteTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): Promise<void> {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventInTransaction(database, resolved, event);
    }, toDatabaseOptions(resolved));
  });
}

/** Appends one transcript message to the additive SQLite transcript store. */
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>>;
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: TranscriptMessageAppendResult<TMessage> | undefined;
    runOpenClawAgentWriteTransaction((database) => {
      const idempotencyKey = readMessageIdempotencyKey(options.message);
      if (idempotencyKey && options.idempotencyLookup === "scan") {
        const existing = readTranscriptMessageByIdempotencyKey(database, resolved, idempotencyKey);
        if (existing) {
          result = {
            appended: false,
            message: existing.message as TMessage,
            messageId: existing.messageId,
          };
          return;
        }
      }

      const prepared = options.prepareMessageAfterIdempotencyCheck
        ? options.prepareMessageAfterIdempotencyCheck(options.message)
        : options.message;
      if (prepared === undefined) {
        result = undefined;
        return;
      }

      const messageId = randomUUID();
      const now = options.now ?? Date.now();
      const finalMessage = redactTranscriptMessageForStorage(prepared, options);
      ensureTranscriptHeader(database, resolved, options.cwd, now);
      const parentId = readLatestTranscriptMessageId(database, resolved.sessionId);
      const event = {
        type: "message",
        id: messageId,
        parentId: parentId ?? null,
        timestamp: resolveTimestampMsToIsoString(now),
        message: finalMessage,
      };
      const appended = appendTranscriptEventInTransaction(database, resolved, event, {
        dedupeByMessageIdempotency: options.idempotencyLookup === "scan",
      });
      if (!appended && idempotencyKey && options.idempotencyLookup === "scan") {
        const existing = readTranscriptMessageByIdempotencyKey(database, resolved, idempotencyKey);
        if (existing) {
          result = {
            appended: false,
            message: existing.message as TMessage,
            messageId: existing.messageId,
          };
          return;
        }
      }
      if (!appended) {
        throw new Error(`SQLite transcript append did not insert message ${messageId}.`);
      }
      result = {
        appended: true,
        message: finalMessage,
        messageId,
      };
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Publishes a transcript update using the SQLite transcript scope target. */
export async function publishSqliteTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  void scope;
  void update;
  // SessionTranscriptUpdate.sessionFile is still a real file-path contract.
  // SQLite updates stay quiet until listeners support typed SQLite targets.
}

function getSessionKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SessionSqliteDatabase>(database);
}

async function runExclusiveSqliteSessionWrite<T>(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  fn: () => Promise<T>,
): Promise<T> {
  const databaseOptions = toDatabaseOptions(scope);
  return await runQueuedStoreWrite({
    queues: SQLITE_SESSION_WRITER_QUEUES,
    storePath: resolveOpenClawAgentSqlitePath(databaseOptions),
    label: "runExclusiveSqliteSessionWrite",
    fn,
  });
}

function resolveSqliteScope(
  scope: Pick<SessionAccessScope, "agentId" | "env" | "sessionKey" | "storePath">,
): ResolvedSqliteScope {
  const storeTarget = scope.storePath
    ? resolveSqliteTargetFromSessionStorePath(scope.storePath)
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: scope.agentId,
    sessionKey: scope.sessionKey,
    storeAgentId: storeTarget?.agentId,
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  return {
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    sessionKey: normalizeSqliteSessionKey(scope.sessionKey),
  };
}

function resolveSqliteReadScope(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionKey" | "storePath">,
): ResolvedSqliteReadScope {
  const storeTarget = scope.storePath
    ? resolveSqliteTargetFromSessionStorePath(scope.storePath)
    : undefined;
  const sessionKey = scope.sessionKey ? normalizeSqliteSessionKey(scope.sessionKey) : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId: scope.agentId,
    sessionKey,
    storeAgentId: storeTarget?.agentId,
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite transcript read scope without an agent id");
  }
  return {
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveSqliteTargetFromSessionStorePath(storePath: string): ResolvedSqliteStoreTarget {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) === "openclaw-agent.sqlite" || resolved.endsWith(".sqlite")) {
    const agentId = resolveAgentIdFromSqliteDatabasePath(resolved);
    return {
      path: resolved,
      ...(agentId ? { agentId } : {}),
    };
  }
  if (path.basename(resolved) !== "sessions.json") {
    return {};
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(sessionsDir) !== "sessions") {
    return {};
  }
  const agentDir = path.dirname(sessionsDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return {};
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir)),
    path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
  };
}

function resolveSqliteAgentId(params: {
  scopedAgentId?: string;
  sessionKey?: string;
  storeAgentId?: string;
}): string | undefined {
  const scopedAgentId = params.scopedAgentId ? normalizeAgentId(params.scopedAgentId) : undefined;
  if (scopedAgentId && params.storeAgentId && scopedAgentId !== params.storeAgentId) {
    throw new Error(
      `SQLite session store path belongs to agent ${params.storeAgentId}; requested agent ${scopedAgentId}.`,
    );
  }
  return (
    scopedAgentId ??
    params.storeAgentId ??
    (params.sessionKey !== undefined ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined)
  );
}

function resolveAgentIdFromSqliteDatabasePath(databasePath: string): string | undefined {
  if (path.basename(databasePath) !== "openclaw-agent.sqlite") {
    return undefined;
  }
  const agentDbDir = path.dirname(databasePath);
  if (path.basename(agentDbDir) !== "agent") {
    return undefined;
  }
  const agentDir = path.dirname(agentDbDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return undefined;
  }
  return normalizeAgentId(path.basename(agentDir));
}

function resolveSqliteTranscriptScope(
  scope: Pick<
    SessionTranscriptWriteScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
): ResolvedTranscriptScope {
  if (!scope.sessionId) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session id: ${scope.sessionKey}`,
    );
  }
  if (!scope.sessionKey) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session key: ${scope.sessionId}`,
    );
  }
  return {
    ...resolveSqliteScope({
      ...scope,
      sessionKey: scope.sessionKey,
    }),
    sessionId: scope.sessionId,
  };
}

function resolveSqliteTranscriptReadScope(
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
): ResolvedTranscriptReadScope {
  return {
    ...resolveSqliteReadScope(scope),
    sessionId: scope.sessionId,
  };
}

function toDatabaseOptions(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): OpenClawAgentDatabaseOptions {
  return {
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.path ? { path: scope.path } : {}),
  };
}

function normalizeSqliteSessionKey(sessionKey: string): string {
  return normalizeStoreSessionKey(sessionKey);
}

function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
  };
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry);
}

function normalizeSqliteText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSqliteChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

function normalizeSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function parseSessionEntryRow(row: Pick<SessionEntryRow, "entry_json">): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SessionEntry)
      : null;
  } catch {
    return null;
  }
}

function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }
  // Message records require parent-link, idempotency, and redaction handling
  // from appendSqliteTranscriptMessage; raw event writes would bypass those invariants.
  if ((event as { type?: unknown }).type === "message") {
    throw new Error(
      "appendSqliteTranscriptEvent cannot write message transcript records; use appendSqliteTranscriptMessage instead.",
    );
  }
}

function readSessionEntryRow(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").selectAll().orderBy("session_key", "asc"),
  ).rows;
  const entries = new Map<string, ResolvedSessionEntryRow>();
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    store[row.session_key] = entry;
    entries.set(row.session_key, { entry, legacyKeys: [], row });
  }
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  if (!resolved.existing) {
    return undefined;
  }
  for (const value of entries.values()) {
    if (value.entry === resolved.existing) {
      return { ...value, legacyKeys: resolved.legacyKeys };
    }
  }
  return undefined;
}

function readExactSessionEntryRow(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").selectAll().where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  const entry = parseSessionEntryRow(row);
  return entry ? { entry, legacyKeys: [], row } : undefined;
}

function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_key", "=", legacyKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", legacyKey),
    );
  }
}

function applySqliteSessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: { activeSessionKey: string; skipMaintenance?: boolean },
): void {
  if (params.skipMaintenance) {
    return;
  }
  const maintenance = resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return;
  }

  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }

  const removedKeys = new Set<string>();
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry = (params: { key: string; entry: SessionEntry }) => {
    removedKeys.add(params.key);
    removedSessionIds.add(params.entry.sessionId);
  };
  const preserveKeys = collectSessionMaintenancePreserveKeys([params.activeSessionKey]);
  pruneStaleEntries(store, maintenance.pruneAfterMs, {
    log: false,
    onPruned: rememberRemovedEntry,
    preserveKeys,
  });
  if (
    shouldRunSessionEntryMaintenance({
      entryCount: Object.keys(store).length,
      maxEntries: maintenance.maxEntries,
    })
  ) {
    capEntryCount(store, maintenance.maxEntries, {
      log: false,
      onCapped: rememberRemovedEntry,
      preserveKeys,
    });
  }

  for (const sessionKey of removedKeys) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_key", "=", sessionKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", sessionKey),
    );
  }
  const referencedSessionIds = readReferencedSqliteSessionIds(database);
  for (const sessionId of removedSessionIds) {
    deleteSqliteSessionStateIfUnreferenced({
      database,
      referencedSessionIds,
      sessionId,
    });
  }
}

function sessionKeySegmentStartsWith(sessionKey: string, prefix: string): boolean {
  const firstSeparator = sessionKey.indexOf(":");
  if (firstSeparator < 0) {
    return sessionKey.startsWith(prefix);
  }
  const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1);
  return sessionSegment.startsWith(prefix);
}

function readSessionTranscriptUpdatedAt(
  database: OpenClawAgentDatabase,
  sessionId: string,
): number | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"))
      .where("session_id", "=", sessionId),
  );
  if (row?.updated_at === null || row?.updated_at === undefined) {
    return undefined;
  }
  return normalizeSqliteNumber(row.updated_at);
}

function sqliteTranscriptStateIsReclaimable(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  const updatedAt = readSessionTranscriptUpdatedAt(params.database, params.sessionId);
  return updatedAt === undefined || params.nowMs - updatedAt >= params.orphanTranscriptMinAgeMs;
}

function sqliteTranscriptStateHasMarker(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  transcriptContentMarker: string;
}): boolean {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", params.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.some((row) => row.event_json.includes(params.transcriptContentMarker));
}

function readReferencedSqliteSessionIds(database: OpenClawAgentDatabase): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select("session_id"),
  ).rows;
  return new Set(rows.map((row) => row.session_id));
}

function deleteSqliteSessionStateIfUnreferenced(params: {
  database: OpenClawAgentDatabase;
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): number {
  if (params.referencedSessionIds.has(params.sessionId)) {
    return 0;
  }
  const hadTranscriptState =
    readSessionTranscriptUpdatedAt(params.database, params.sessionId) !== undefined;
  const db = getSessionKysely(params.database.db);
  executeSqliteQuerySync(
    params.database.db,
    db.deleteFrom("sessions").where("session_id", "=", params.sessionId),
  );
  return hadTranscriptState ? 1 : 0;
}

function cleanupSqliteOrphanLifecycleTranscriptState(params: {
  database: OpenClawAgentDatabase;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): number {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("sessions").select("session_id").orderBy("session_id", "asc"),
  ).rows;

  let removed = 0;
  // Orphan transcript state is represented by a sessions row without a live
  // session entry. The marker keeps this scoped to the caller-owned lifecycle.
  for (const row of rows) {
    if (params.referencedSessionIds.has(row.session_id)) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database: params.database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      }) ||
      !sqliteTranscriptStateHasMarker({
        database: params.database,
        sessionId: row.session_id,
        transcriptContentMarker: params.transcriptContentMarker,
      })
    ) {
      continue;
    }
    executeSqliteQuerySync(
      params.database.db,
      db.deleteFrom("sessions").where("session_id", "=", row.session_id),
    );
    removed += 1;
  }
  return removed;
}

function cleanupSqliteSessionLifecycleArtifactsInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
  },
): SessionLifecycleArtifactCleanupResult {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "session_id"])
      .orderBy("session_key", "asc"),
  ).rows;

  const removedSessionIds = new Set<string>();
  let removedEntries = 0;
  // Delete matching lifecycle entries first; session/transcript state is only
  // removed after we rebuild the post-delete reference set below.
  for (const row of rows) {
    if (!sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      })
    ) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_key", "=", row.session_key),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", row.session_key),
    );
    removedSessionIds.add(row.session_id);
    removedEntries += 1;
  }

  const referencedSessionIds = readReferencedSqliteSessionIds(database);
  let archivedTranscriptArtifacts = 0;
  for (const sessionId of removedSessionIds) {
    archivedTranscriptArtifacts += deleteSqliteSessionStateIfUnreferenced({
      database,
      referencedSessionIds,
      sessionId,
    });
  }
  archivedTranscriptArtifacts += cleanupSqliteOrphanLifecycleTranscriptState({
    database,
    referencedSessionIds,
    transcriptContentMarker: params.transcriptContentMarker,
    orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
    nowMs: params.nowMs,
  });
  return { removedEntries, archivedTranscriptArtifacts };
}

function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const db = getSessionKysely(database.db);
  const normalizedEntry = normalizeSqliteSessionEntryTimestamp(entry);
  const updatedAt = normalizedEntry.updatedAt;
  const sessionRow = bindSqliteSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values(sessionRow)
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          session_scope: sessionRow.session_scope,
          updated_at: updatedAt,
          started_at: sessionRow.started_at,
          ended_at: sessionRow.ended_at,
          status: sessionRow.status,
          chat_type: sessionRow.chat_type,
          channel: sessionRow.channel,
          account_id: sessionRow.account_id,
          model_provider: sessionRow.model_provider,
          model: sessionRow.model,
          agent_harness_id: sessionRow.agent_harness_id,
          parent_session_key: sessionRow.parent_session_key,
          spawned_by: sessionRow.spawned_by,
          display_name: sessionRow.display_name,
        }),
      ),
  );
  writeSessionRoute(database, {
    sessionId: sessionRow.session_id,
    sessionKey,
    updatedAt,
  });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_entries")
      .values({
        session_key: sessionKey,
        session_id: normalizedEntry.sessionId,
        entry_json: JSON.stringify(normalizedEntry),
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: normalizedEntry.sessionId,
          entry_json: JSON.stringify(normalizedEntry),
          updated_at: updatedAt,
        }),
      ),
  );
}

function normalizeSqliteSessionEntryTimestamp(entry: SessionEntry): SessionEntry {
  if (typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)) {
    return entry;
  }
  const updatedAt =
    typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)
      ? entry.sessionStartedAt
      : Date.now();
  return {
    ...entry,
    updatedAt,
  };
}

function ensureTranscriptSessionRoot(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  updatedAt: number,
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values({
        session_id: scope.sessionId,
        session_key: scope.sessionKey,
        session_scope: "conversation",
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: scope.sessionKey,
          updated_at: updatedAt,
        }),
      ),
  );
  writeTranscriptSessionRoute(database, {
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    updatedAt,
  });
}

function bindSqliteSessionRoot(params: {
  entry: SessionEntry;
  sessionKey: string;
  updatedAt: number;
}) {
  const updatedAt = Number.isFinite(params.entry.updatedAt)
    ? params.entry.updatedAt
    : params.updatedAt;
  return {
    session_id: params.entry.sessionId,
    session_key: params.sessionKey,
    session_scope: resolveSqliteSessionScope(params.entry, params.sessionKey),
    created_at: resolveSqliteSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    started_at: finiteSqliteNumber(params.entry.startedAt),
    ended_at: finiteSqliteNumber(params.entry.endedAt),
    status: normalizeSqliteText(params.entry.status),
    chat_type: normalizeSqliteChatType(params.entry.chatType),
    channel: resolveSqliteSessionChannel(params.entry),
    account_id: resolveSqliteSessionAccountId(params.entry),
    primary_conversation_id: null,
    model_provider: normalizeSqliteText(params.entry.modelProvider),
    model: normalizeSqliteText(params.entry.model),
    agent_harness_id: normalizeSqliteText(params.entry.agentHarnessId),
    parent_session_key: normalizeSqliteText(params.entry.parentSessionKey),
    spawned_by: normalizeSqliteText(params.entry.spawnedBy),
    display_name: resolveSqliteSessionDisplayName(params.entry),
  };
}

function writeSessionRoute(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_routes")
      .values({
        session_key: params.sessionKey,
        session_id: params.sessionId,
        updated_at: params.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: params.sessionId,
          updated_at: params.updatedAt,
        }),
      ),
  );
}

function writeTranscriptSessionRoute(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_routes")
      .select("session_id")
      .where("session_key", "=", params.sessionKey),
  );
  // Transcript-only appends may arrive late from an old run. They can create
  // missing routes, but must not move a current session key back to a stale id.
  if (existing && existing.session_id !== params.sessionId) {
    return;
  }
  writeSessionRoute(database, params);
}

function resolveSqliteSessionScope(
  entry: Pick<SessionEntry, "chatType">,
  sessionKey: string,
): "conversation" | "shared-main" | "group" | "channel" {
  const chatType = normalizeSqliteChatType(entry.chatType);
  const normalizedKey = sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (normalizedKey === "main" || normalizedKey.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}

function resolveSqliteSessionCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}

function finiteSqliteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveSqliteSessionChannel(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.channel) ??
    normalizeSqliteText(entry.deliveryContext?.channel) ??
    normalizeSqliteText(entry.lastChannel) ??
    normalizeSqliteText(entry.origin?.provider)
  );
}

function resolveSqliteSessionAccountId(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.deliveryContext?.accountId) ??
    normalizeSqliteText(entry.lastAccountId) ??
    normalizeSqliteText(entry.origin?.accountId)
  );
}

function resolveSqliteSessionDisplayName(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.displayName) ??
    normalizeSqliteText(entry.label) ??
    normalizeSqliteText(entry.subject) ??
    normalizeSqliteText(entry.groupId)
  );
}

function readNextTranscriptSeq(database: OpenClawAgentDatabase, sessionId: string): number {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("seq").as("max_seq"))
      .where("session_id", "=", sessionId),
  );
  const maxSeq =
    row?.max_seq === null || row?.max_seq === undefined ? -1 : normalizeSqliteNumber(row.max_seq);
  return maxSeq + 1;
}

function appendTranscriptEventInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: { dedupeByMessageIdempotency?: boolean } = {},
): boolean {
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(event) ?? Date.now();
  ensureTranscriptSessionRoot(database, scope, createdAt);
  const identity = readTranscriptEventIdentity(event);
  if (identity && readTranscriptIdentityByEventId(database, scope.sessionId, identity.eventId)) {
    return false;
  }
  if (
    identity?.messageIdempotencyKey &&
    options.dedupeByMessageIdempotency &&
    readTranscriptIdentityByMessageIdempotencyKey(
      database,
      scope.sessionId,
      identity.messageIdempotencyKey,
    )
  ) {
    return false;
  }
  const seq = readNextTranscriptSeq(database, scope.sessionId);
  executeSqliteQuerySync(
    database.db,
    db.insertInto("transcript_events").values({
      session_id: scope.sessionId,
      seq,
      event_json: JSON.stringify(event),
      created_at: createdAt,
    }),
  );
  if (!identity) {
    return true;
  }
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_event_identities")
      .values({
        session_id: scope.sessionId,
        event_id: identity.eventId,
        seq,
        event_type: identity.eventType,
        parent_id: identity.parentId,
        message_idempotency_key: identity.messageIdempotencyKey,
        created_at: createdAt,
      })
      .onConflict((conflict) => conflict.columns(["session_id", "event_id"]).doNothing()),
  );
  return true;
}

function ensureTranscriptHeader(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  cwd: string | undefined,
  now: number,
): void {
  const db = getSessionKysely(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", scope.sessionId)
      .limit(1),
  );
  if (existing) {
    return;
  }
  appendTranscriptEventInTransaction(
    database,
    scope,
    createSessionTranscriptHeader({
      cwd,
      sessionId: scope.sessionId,
    }),
  );
  ensureTranscriptSessionRoot(database, scope, now);
}

function readLatestTranscriptMessageId(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id"])
      .where("session_id", "=", sessionId)
      .where("event_type", "=", "message")
      .orderBy("seq", "desc")
      .limit(1),
  );
  return row?.event_id;
}

function readTranscriptIdentityByEventId(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string,
): { eventId: string; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_id", "=", eventId),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

function readTranscriptIdentityByMessageIdempotencyKey(
  database: OpenClawAgentDatabase,
  sessionId: string,
  idempotencyKey: string,
): { eventId: string; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("message_idempotency_key", "=", idempotencyKey)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

function readTranscriptMessageByIdempotencyKey(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByMessageIdempotencyKey(
    database,
    scope.sessionId,
    idempotencyKey,
  );
  if (!identity) {
    return undefined;
  }
  const db = getSessionKysely(database.db);
  const eventRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", scope.sessionId)
      .where("seq", "=", identity.seq),
  );
  if (!eventRow) {
    return undefined;
  }
  const event = JSON.parse(eventRow.event_json) as { message?: unknown };
  return {
    messageId: identity.eventId,
    message: event.message,
  };
}

function readTranscriptEventIdentity(event: unknown):
  | {
      eventId: string;
      eventType: string | null;
      parentId: string | null;
      messageIdempotencyKey: string | null;
    }
  | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  const eventId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  if (!eventId) {
    return undefined;
  }
  return {
    eventId,
    eventType: typeof record.type === "string" ? record.type : null,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    messageIdempotencyKey: readMessageIdempotencyKey(record.message),
  };
}

function readMessageIdempotencyKey(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const value = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEventTimestamp(event: unknown): number | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const value = (event as { timestamp?: unknown }).timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redactTranscriptMessageForStorage<TMessage>(
  message: TMessage,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "config">,
): TMessage {
  if (isTranscriptAgentMessage(message)) {
    return redactTranscriptMessage(message, options.config) as TMessage;
  }
  return redactSecrets(message);
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string"
  );
}
