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
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntrySummary,
  SessionEntryUpdateOptions,
  SessionTranscriptAccessScope,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
  TranscriptUpdatePayload,
} from "./session-accessor.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry, mergeSessionEntryPreserveActivity } from "./types.js";

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_entries" | "sessions" | "transcript_event_identities" | "transcript_events"
>;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_entries"]>;

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

/** Loads one session entry from the additive SQLite session store. */
export function loadSqliteSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSessionEntryRow(database, resolved.sessionKey)?.entry;
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
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_entries")
      .select("updated_at")
      .where("session_key", "=", resolved.sessionKey),
  );
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
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  const existing = loadSqliteSessionEntry(scope);
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
  const next = options.replaceEntry
    ? cloneSessionEntry(patch as SessionEntry)
    : options.preserveActivity
      ? mergeSessionEntryPreserveActivity(base, patch)
      : mergeSessionEntry(base, patch);
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, resolved.sessionKey, next);
  }, toDatabaseOptions(resolved));
  return cloneSessionEntry(next);
}

/** Updates an existing entry in the additive SQLite session store. */
export async function updateSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  _options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  const existing = loadSqliteSessionEntry(scope);
  if (!existing) {
    return null;
  }
  const patch = await update(cloneSessionEntry(existing));
  if (!patch) {
    return cloneSessionEntry(existing);
  }
  const next = mergeSessionEntry(existing, patch);
  const resolved = resolveSqliteScope(scope);
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, resolved.sessionKey, next);
  }, toDatabaseOptions(resolved));
  return cloneSessionEntry(next);
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
  const resolved = resolveSqliteTranscriptScope(scope);
  runOpenClawAgentWriteTransaction((database) => {
    appendTranscriptEventInTransaction(database, resolved, event);
  }, toDatabaseOptions(resolved));
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
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (idempotencyKey && options.idempotencyLookup === "scan") {
    const existing = readTranscriptMessageByIdempotencyKey(resolved, idempotencyKey);
    if (existing) {
      return {
        appended: false,
        message: existing.message as TMessage,
        messageId: existing.messageId,
      };
    }
  }

  const prepared = options.prepareMessageAfterIdempotencyCheck
    ? options.prepareMessageAfterIdempotencyCheck(options.message)
    : options.message;
  if (prepared === undefined) {
    return undefined;
  }

  const messageId = randomUUID();
  const now = options.now ?? Date.now();
  const finalMessage = redactTranscriptMessageForStorage(prepared, options);
  runOpenClawAgentWriteTransaction((database) => {
    ensureTranscriptHeader(database, resolved, options.cwd, now);
    const parentId = readLatestTranscriptMessageId(database, resolved.sessionId);
    const event = {
      type: "message",
      id: messageId,
      parentId: parentId ?? null,
      timestamp: resolveTimestampMsToIsoString(now),
      message: finalMessage,
    };
    appendTranscriptEventInTransaction(database, resolved, event);
  }, toDatabaseOptions(resolved));
  return {
    appended: true,
    message: finalMessage,
    messageId,
  };
}

/** Publishes a transcript update using the SQLite transcript scope target. */
export async function publishSqliteTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  const resolved = resolveSqliteTranscriptScope(scope);
  emitSessionTranscriptUpdate({
    ...update,
    sessionFile: formatSqliteTranscriptTarget(resolved),
  });
}

function getSessionKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SessionSqliteDatabase>(database);
}

function resolveSqliteScope(
  scope: Pick<SessionAccessScope, "agentId" | "env" | "sessionKey" | "storePath">,
): ResolvedSqliteScope {
  const storeTarget = scope.storePath
    ? resolveSqliteTargetFromSessionStorePath(scope.storePath)
    : undefined;
  return {
    agentId: scope.agentId
      ? normalizeAgentId(scope.agentId)
      : (storeTarget?.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey)),
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
  const agentId = scope.agentId
    ? normalizeAgentId(scope.agentId)
    : (storeTarget?.agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined));
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
    return { path: resolved };
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
  return {
    ...resolveSqliteScope(scope),
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

function readSessionEntryRow(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): { entry: SessionEntry; row: SessionEntryRow } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_entries")
      .selectAll()
      .where("session_key", "=", normalizeSqliteSessionKey(sessionKey)),
  );
  if (!row) {
    return undefined;
  }
  const entry = parseSessionEntryRow(row);
  return entry ? { entry, row } : undefined;
}

function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const db = getSessionKysely(database.db);
  const updatedAt = entry.updatedAt;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values({
        session_id: entry.sessionId,
        session_key: sessionKey,
        created_at: entry.sessionStartedAt ?? updatedAt,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          updated_at: updatedAt,
        }),
      ),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_entries")
      .values({
        session_key: sessionKey,
        session_id: entry.sessionId,
        entry_json: JSON.stringify(entry),
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: entry.sessionId,
          entry_json: JSON.stringify(entry),
          updated_at: updatedAt,
        }),
      ),
  );
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
): void {
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(event) ?? Date.now();
  ensureTranscriptSessionRoot(database, scope, createdAt);
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
  const identity = readTranscriptEventIdentity(event);
  if (!identity) {
    return;
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

function readTranscriptMessageByIdempotencyKey(
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
): { messageId: string; message: unknown } | undefined {
  const database = openOpenClawAgentDatabase(toDatabaseOptions(scope));
  const db = getSessionKysely(database.db);
  const identity = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", scope.sessionId)
      .where("message_idempotency_key", "=", idempotencyKey)
      .orderBy("seq", "desc")
      .limit(1),
  );
  if (!identity) {
    return undefined;
  }
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
    messageId: identity.event_id,
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

function formatSqliteTranscriptTarget(scope: ResolvedTranscriptScope): string {
  const pathPart = scope.path ? `:${scope.path}` : "";
  return `sqlite:${scope.agentId}:${scope.sessionId}${pathPart}`;
}
