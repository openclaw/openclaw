import type { Insertable, Selectable } from "kysely";
import { normalizeChatType } from "../../channels/chat-type.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  type OpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { type OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import {
  conversationIdentityFromSessionEntry,
  type ConversationIdentity,
} from "./conversation-identity.js";
import { normalizeSessionEntries } from "./session-entry-normalize.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionEntriesOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  now?: () => number;
};

export type ReplaceSqliteSessionEntryOptions = SqliteSessionEntriesOptions & {
  sessionKey: string;
  entry: SessionEntry;
  conversationIdentities?: readonly ConversationIdentity[];
};

export type ApplySqliteSessionEntriesPatchOptions = SqliteSessionEntriesOptions & {
  upsertEntries?: Readonly<Record<string, SessionEntry>>;
  expectedEntries?: ReadonlyMap<string, SessionEntry | null>;
};

export type SqliteSessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

export type SqliteSessionRoutingInfo = {
  sessionScope?: string;
  chatType?: string;
  channel?: string;
  accountId?: string;
  primaryConversationId?: string;
  conversationKind?: string;
  conversationPeerId?: string;
  conversationThreadId?: string;
};

type SessionEntriesTable = OpenClawAgentKyselyDatabase["session_entries"];
type SessionsTable = OpenClawAgentKyselyDatabase["sessions"];
type ConversationsTable = OpenClawAgentKyselyDatabase["conversations"];
type SessionConversationsTable = OpenClawAgentKyselyDatabase["session_conversations"];
type SessionEntriesDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "conversations" | "session_conversations" | "session_entries" | "sessions"
>;

type SessionEntryRow = Pick<Selectable<SessionEntriesTable>, "entry_json" | "session_key"> &
  Partial<Pick<Selectable<SessionEntriesTable>, "updated_at">> & {
    typed_session_id?: string | null;
    typed_updated_at?: number | null;
    typed_started_at?: number | null;
    typed_ended_at?: number | null;
    typed_status?: string | null;
    typed_chat_type?: string | null;
    typed_channel?: string | null;
    typed_account_id?: string | null;
    typed_model_provider?: string | null;
    typed_model?: string | null;
    typed_agent_harness_id?: string | null;
    typed_parent_session_key?: string | null;
    typed_spawned_by?: string | null;
    typed_display_name?: string | null;
    typed_conversation_channel?: string | null;
    typed_conversation_account_id?: string | null;
    typed_conversation_kind?: string | null;
    typed_conversation_peer_id?: string | null;
    typed_conversation_thread_id?: string | null;
  };
type BoundSessionEntryRow = {
  entry: Insertable<SessionEntriesTable>;
  session: Insertable<SessionsTable>;
  conversations: readonly ConversationIdentity[];
};

function resolveNow(options: SqliteSessionEntriesOptions): number {
  return options.now?.() ?? Date.now();
}

function parseSessionEntry(row: SessionEntryRow): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const entries = { [row.session_key]: parsed as SessionEntry };
    normalizeSessionEntries(entries);
    return entries[row.session_key] ?? null;
  } catch {
    return null;
  }
}

function clearCompatibilityRoutingShadow(entry: SessionEntry): void {
  delete entry.deliveryContext;
  delete entry.lastChannel;
  delete entry.lastTo;
  delete entry.lastAccountId;
  delete entry.lastThreadId;
}

function projectTypedSessionColumns(row: SessionEntryRow): SessionEntry | null {
  const parsed = parseSessionEntry(row);
  const sessionId = optionalString(row.typed_session_id) ?? parsed?.sessionId;
  const updatedAt =
    typeof row.typed_updated_at === "number" && Number.isFinite(row.typed_updated_at)
      ? row.typed_updated_at
      : parsed?.updatedAt;
  if (!parsed && (!sessionId || typeof updatedAt !== "number")) {
    return null;
  }
  const next: SessionEntry = {
    ...(parsed ?? {
      sessionId: sessionId ?? row.session_key,
      updatedAt: updatedAt ?? 0,
    }),
  };
  clearCompatibilityRoutingShadow(next);
  if (sessionId) {
    next.sessionId = sessionId;
  }
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
    next.updatedAt = updatedAt;
  }
  if (typeof row.typed_started_at === "number" && Number.isFinite(row.typed_started_at)) {
    next.startedAt = row.typed_started_at;
  }
  if (typeof row.typed_ended_at === "number" && Number.isFinite(row.typed_ended_at)) {
    next.endedAt = row.typed_ended_at;
  }
  const status = parseSessionStatus(row.typed_status);
  if (status) {
    next.status = status;
  }
  const chatType =
    normalizeChatType(optionalString(row.typed_chat_type)) ??
    normalizeChatType(optionalString(row.typed_conversation_kind));
  if (chatType) {
    next.chatType = chatType;
  }
  const channel = optionalString(row.typed_channel);
  if (channel) {
    next.channel = channel;
    next.lastChannel = channel;
  }
  const accountId = optionalString(row.typed_account_id);
  if (accountId) {
    next.lastAccountId = accountId;
  }
  const conversationChannel = optionalString(row.typed_conversation_channel);
  const conversationTo = optionalString(row.typed_conversation_peer_id);
  const conversationAccountId = optionalString(row.typed_conversation_account_id) ?? accountId;
  const conversationThreadId = optionalThreadId(row.typed_conversation_thread_id);
  if (conversationChannel) {
    next.channel = channel ?? conversationChannel;
    next.lastChannel = conversationChannel;
  }
  if (conversationTo) {
    next.lastTo = conversationTo;
    next.deliveryContext = {
      ...(next.deliveryContext ?? {}),
      to: conversationTo,
      ...((conversationChannel ?? channel) ? { channel: conversationChannel ?? channel } : {}),
      ...(conversationAccountId ? { accountId: conversationAccountId } : {}),
      ...(conversationThreadId ? { threadId: conversationThreadId } : {}),
    };
  }
  if (conversationAccountId) {
    next.lastAccountId = conversationAccountId;
  }
  if (conversationThreadId) {
    next.lastThreadId = conversationThreadId;
  }
  const modelProvider = optionalString(row.typed_model_provider);
  if (modelProvider) {
    next.modelProvider = modelProvider;
  }
  const model = optionalString(row.typed_model);
  if (model) {
    next.model = model;
  }
  const agentHarnessId = optionalString(row.typed_agent_harness_id);
  if (agentHarnessId) {
    next.agentHarnessId = agentHarnessId;
  }
  const parentSessionKey = optionalString(row.typed_parent_session_key);
  if (parentSessionKey) {
    next.parentSessionKey = parentSessionKey;
  }
  const spawnedBy = optionalString(row.typed_spawned_by);
  if (spawnedBy) {
    next.spawnedBy = spawnedBy;
  }
  const displayName = optionalString(row.typed_display_name);
  if (displayName) {
    next.displayName = displayName;
  }
  return next;
}

function selectSessionEntryRows(
  db: ReturnType<typeof getNodeSqliteKysely<SessionEntriesDatabase>>,
) {
  return db
    .selectFrom("session_entries as se")
    .innerJoin("sessions as s", "s.session_id", "se.session_id")
    .leftJoin("conversations as c", "c.conversation_id", "s.primary_conversation_id")
    .select([
      "se.session_key as session_key",
      "se.entry_json as entry_json",
      "se.updated_at as updated_at",
      "s.session_id as typed_session_id",
      "s.updated_at as typed_updated_at",
      "s.started_at as typed_started_at",
      "s.ended_at as typed_ended_at",
      "s.status as typed_status",
      "s.chat_type as typed_chat_type",
      "s.channel as typed_channel",
      "s.account_id as typed_account_id",
      "s.model_provider as typed_model_provider",
      "s.model as typed_model",
      "s.agent_harness_id as typed_agent_harness_id",
      "s.parent_session_key as typed_parent_session_key",
      "s.spawned_by as typed_spawned_by",
      "s.display_name as typed_display_name",
      "c.channel as typed_conversation_channel",
      "c.account_id as typed_conversation_account_id",
      "c.kind as typed_conversation_kind",
      "c.peer_id as typed_conversation_peer_id",
      "c.thread_id as typed_conversation_thread_id",
    ]);
}

function serializeSessionEntry(sessionKey: string, entry: SessionEntry): string {
  const entries = { [sessionKey]: entry };
  normalizeSessionEntries(entries);
  return JSON.stringify(entries[sessionKey] ?? entry);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
  return nullableString(value) ?? undefined;
}

function parseSessionStatus(value: unknown): SessionEntry["status"] | undefined {
  if (
    value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
  ) {
    return value;
  }
  return undefined;
}

function optionalThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return optionalString(value);
}

function sessionDisplayName(entry: SessionEntry): string | null {
  return nullableString(entry.displayName) ?? nullableString(entry.label);
}

function resolveSessionScope(params: { entry: SessionEntry; sessionKey: string }): string {
  const chatType =
    nullableString(params.entry.chatType) ?? nullableString(params.entry.origin?.chatType);
  const key = params.sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (key === "main" || key.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}

function resolveSessionCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}

function bindSessionRoot(params: {
  sessionKey: string;
  entry: SessionEntry;
  updatedAt: number;
  primaryConversation?: ConversationIdentity | null;
}): Insertable<SessionsTable> {
  const sessionId = nullableString(params.entry.sessionId) ?? params.sessionKey;
  const updatedAt =
    typeof params.entry.updatedAt === "number" && Number.isFinite(params.entry.updatedAt)
      ? params.entry.updatedAt
      : params.updatedAt;
  return {
    session_id: sessionId,
    session_key: params.sessionKey,
    session_scope: resolveSessionScope(params),
    created_at: resolveSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    started_at:
      typeof params.entry.startedAt === "number" && Number.isFinite(params.entry.startedAt)
        ? params.entry.startedAt
        : null,
    ended_at:
      typeof params.entry.endedAt === "number" && Number.isFinite(params.entry.endedAt)
        ? params.entry.endedAt
        : null,
    status: nullableString(params.entry.status),
    chat_type: nullableString(params.entry.chatType),
    channel: nullableString(params.entry.channel) ?? nullableString(params.entry.lastChannel),
    account_id:
      nullableString(params.primaryConversation?.accountId) ??
      nullableString(params.entry.lastAccountId) ??
      nullableString(params.entry.origin?.accountId),
    primary_conversation_id: nullableString(params.primaryConversation?.conversationId),
    model_provider: nullableString(params.entry.modelProvider),
    model: nullableString(params.entry.model),
    agent_harness_id: nullableString(params.entry.agentHarnessId),
    parent_session_key: nullableString(params.entry.parentSessionKey),
    spawned_by: nullableString(params.entry.spawnedBy),
    display_name: sessionDisplayName(params.entry),
  };
}

function bindSessionEntry(params: {
  sessionKey: string;
  entry: SessionEntry;
  updatedAt: number;
  conversationIdentities?: readonly ConversationIdentity[];
}): BoundSessionEntryRow {
  const conversations = [
    ...(params.conversationIdentities ?? []),
    conversationIdentityFromSessionEntry(params.entry),
  ].filter((entry): entry is ConversationIdentity => entry !== null);
  const uniqueConversations = Array.from(
    new Map(
      conversations.map((conversation) => [conversation.conversationId, conversation]),
    ).values(),
  );
  const session = bindSessionRoot({
    ...params,
    primaryConversation: uniqueConversations[0] ?? null,
  });
  return {
    session,
    conversations: uniqueConversations,
    entry: {
      session_key: params.sessionKey,
      session_id: session.session_id,
      entry_json: serializeSessionEntry(params.sessionKey, params.entry),
      updated_at: session.updated_at,
    },
  };
}

function conversationToRow(
  conversation: ConversationIdentity,
  now: number,
): Insertable<ConversationsTable> {
  return {
    conversation_id: conversation.conversationId,
    channel: conversation.channel,
    account_id: conversation.accountId,
    kind: conversation.kind,
    peer_id: conversation.peerId,
    parent_conversation_id: conversation.parentConversationId ?? null,
    thread_id: conversation.threadId ?? null,
    native_channel_id: conversation.nativeChannelId ?? null,
    native_direct_user_id: conversation.nativeDirectUserId ?? null,
    label: conversation.label ?? null,
    metadata_json: conversation.metadata ? JSON.stringify(conversation.metadata) : null,
    created_at: now,
    updated_at: now,
  };
}

function sessionConversationToRow(params: {
  sessionId: string;
  conversationId: string;
  role: "primary" | "related";
  now: number;
}): Insertable<SessionConversationsTable> {
  return {
    session_id: params.sessionId,
    conversation_id: params.conversationId,
    role: params.role,
    first_seen_at: params.now,
    last_seen_at: params.now,
  };
}

function demoteStalePrimarySessionConversations(
  database: OpenClawAgentDatabase,
  db: ReturnType<typeof getNodeSqliteKysely<SessionEntriesDatabase>>,
  rows: ReadonlyArray<BoundSessionEntryRow>,
  now: number,
): void {
  for (const row of rows) {
    const primaryConversationId = row.conversations[0]?.conversationId;
    if (!primaryConversationId) {
      continue;
    }
    const stalePrimaryRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .select(["conversation_id", "first_seen_at"])
        .where("session_id", "=", row.session.session_id)
        .where("role", "=", "primary")
        .where("conversation_id", "!=", primaryConversationId),
    ).rows;
    if (stalePrimaryRows.length === 0) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_conversations")
        .values(
          stalePrimaryRows.map((stale) => ({
            session_id: row.session.session_id,
            conversation_id: stale.conversation_id,
            role: "related",
            first_seen_at: stale.first_seen_at,
            last_seen_at: now,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet({
            last_seen_at: (eb) => eb.ref("excluded.last_seen_at"),
          }),
        ),
    );
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("session_conversations")
        .where("session_id", "=", row.session.session_id)
        .where("role", "=", "primary")
        .where("conversation_id", "!=", primaryConversationId),
    );
  }
}

function serializeExpectedSessionEntry(sessionKey: string, entry: SessionEntry): string {
  return serializeSessionEntry(sessionKey, entry);
}

function upsertSessionEntries(
  database: OpenClawAgentDatabase,
  rows: ReadonlyArray<BoundSessionEntryRow>,
): void {
  if (rows.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const now = Date.now();
  const conversationRows = Array.from(
    new Map(
      rows.flatMap((row) =>
        row.conversations.map((conversation) => [
          conversation.conversationId,
          conversationToRow(conversation, now),
        ]),
      ),
    ).values(),
  );
  if (conversationRows.length > 0) {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("conversations")
        .values(conversationRows)
        .onConflict((conflict) =>
          conflict.column("conversation_id").doUpdateSet({
            channel: (eb) => eb.ref("excluded.channel"),
            account_id: (eb) => eb.ref("excluded.account_id"),
            kind: (eb) => eb.ref("excluded.kind"),
            peer_id: (eb) => eb.ref("excluded.peer_id"),
            parent_conversation_id: (eb) => eb.ref("excluded.parent_conversation_id"),
            thread_id: (eb) => eb.ref("excluded.thread_id"),
            native_channel_id: (eb) => eb.ref("excluded.native_channel_id"),
            native_direct_user_id: (eb) => eb.ref("excluded.native_direct_user_id"),
            label: (eb) => eb.ref("excluded.label"),
            metadata_json: (eb) => eb.ref("excluded.metadata_json"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
          }),
        ),
    );
  }
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values(rows.map((row) => row.session))
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: (eb) => eb.ref("excluded.session_key"),
          session_scope: (eb) => eb.ref("excluded.session_scope"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
          started_at: (eb) => eb.ref("excluded.started_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
          status: (eb) => eb.ref("excluded.status"),
          chat_type: (eb) => eb.ref("excluded.chat_type"),
          channel: (eb) => eb.ref("excluded.channel"),
          account_id: (eb) => eb.ref("excluded.account_id"),
          primary_conversation_id: (eb) => eb.ref("excluded.primary_conversation_id"),
          model_provider: (eb) => eb.ref("excluded.model_provider"),
          model: (eb) => eb.ref("excluded.model"),
          agent_harness_id: (eb) => eb.ref("excluded.agent_harness_id"),
          parent_session_key: (eb) => eb.ref("excluded.parent_session_key"),
          spawned_by: (eb) => eb.ref("excluded.spawned_by"),
          display_name: (eb) => eb.ref("excluded.display_name"),
        }),
      ),
  );
  demoteStalePrimarySessionConversations(database, db, rows, now);
  const sessionConversationRows = rows.flatMap((row) =>
    row.conversations.map((conversation, index) =>
      sessionConversationToRow({
        sessionId: row.session.session_id,
        conversationId: conversation.conversationId,
        role: index === 0 ? "primary" : "related",
        now,
      }),
    ),
  );
  if (sessionConversationRows.length > 0) {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_conversations")
        .values(sessionConversationRows)
        .onConflict((conflict) =>
          conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet({
            last_seen_at: (eb) => eb.ref("excluded.last_seen_at"),
          }),
        ),
    );
  }
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_entries")
      .values(rows.map((row) => row.entry))
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: (eb) => eb.ref("excluded.session_id"),
          entry_json: (eb) => eb.ref("excluded.entry_json"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      ),
  );
}

function countSessionEntryRows(database: OpenClawAgentDatabase): number {
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select((eb) => eb.fn.countAll<number | bigint>().as("count")),
  );
  const count = row?.count ?? 0;
  return typeof count === "bigint" ? Number(count) : count;
}

function readProjectedSqliteSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): SessionEntry | null {
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    selectSessionEntryRows(db).where("se.session_key", "=", sessionKey),
  );
  return row ? projectTypedSessionColumns(row) : null;
}

export function countSqliteSessionEntries(options: SqliteSessionEntriesOptions): number {
  const database = openOpenClawAgentDatabase(options);
  return countSessionEntryRows(database);
}

export function replaceSqliteSessionEntry(options: ReplaceSqliteSessionEntryOptions): void {
  const entries = { [options.sessionKey]: options.entry };
  normalizeSessionEntries(entries);
  const entry = entries[options.sessionKey] ?? options.entry;
  const updatedAt = resolveNow(options);
  runOpenClawAgentWriteTransaction((database) => {
    upsertSessionEntries(database, [
      bindSessionEntry({
        sessionKey: options.sessionKey,
        entry,
        updatedAt,
        conversationIdentities: options.conversationIdentities,
      }),
    ]);
  }, options);
}

export function applySqliteSessionEntriesPatch(
  options: ApplySqliteSessionEntriesPatchOptions,
): boolean {
  const upsertEntries = { ...options.upsertEntries };
  normalizeSessionEntries(upsertEntries);
  const updatedAt = resolveNow(options);
  return runOpenClawAgentWriteTransaction((database) => {
    for (const [sessionKey, expected] of options.expectedEntries?.entries() ?? []) {
      const current = readProjectedSqliteSessionEntry(database, sessionKey);
      const currentJson = current ? serializeExpectedSessionEntry(sessionKey, current) : null;
      const expectedJson = expected ? serializeExpectedSessionEntry(sessionKey, expected) : null;
      if (currentJson !== expectedJson) {
        return false;
      }
    }
    upsertSessionEntries(
      database,
      Object.entries(upsertEntries).map(([sessionKey, entry]) =>
        bindSessionEntry({
          sessionKey,
          entry,
          updatedAt,
        }),
      ),
    );
    return true;
  }, options);
}

export function readSqliteSessionEntry(
  options: SqliteSessionEntriesOptions & { sessionKey: string },
): SessionEntry | undefined {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    selectSessionEntryRows(db).where("se.session_key", "=", options.sessionKey),
  );
  return row ? (projectTypedSessionColumns(row) ?? undefined) : undefined;
}

function deliveryContextFromTypedRow(row: {
  channel: string;
  account_id: string;
  peer_id: string;
  thread_id: string | null;
}): SqliteSessionDeliveryContext {
  return {
    channel: row.channel,
    to: row.peer_id,
    accountId: row.account_id,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
  };
}

export function readSqliteSessionDeliveryContext(
  options: SqliteSessionEntriesOptions & { sessionKey: string },
): SqliteSessionDeliveryContext | undefined {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const primaryRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("sessions as s")
      .innerJoin("conversations as c", "c.conversation_id", "s.primary_conversation_id")
      .select([
        "c.channel as channel",
        "c.account_id as account_id",
        "c.peer_id as peer_id",
        "c.thread_id as thread_id",
      ])
      .where("s.session_key", "=", options.sessionKey),
  );
  if (primaryRow) {
    return deliveryContextFromTypedRow(primaryRow);
  }
  const linkedRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("sessions as s")
      .innerJoin("session_conversations as sc", "sc.session_id", "s.session_id")
      .innerJoin("conversations as c", "c.conversation_id", "sc.conversation_id")
      .select([
        "c.channel as channel",
        "c.account_id as account_id",
        "c.peer_id as peer_id",
        "c.thread_id as thread_id",
      ])
      .where("s.session_key", "=", options.sessionKey)
      .orderBy("sc.role", "asc")
      .orderBy("sc.last_seen_at", "desc"),
  );
  if (linkedRow) {
    return deliveryContextFromTypedRow(linkedRow);
  }
  return undefined;
}

export function readSqliteSessionRoutingInfo(
  options: SqliteSessionEntriesOptions & { sessionKey: string },
): SqliteSessionRoutingInfo | undefined {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("sessions as s")
      .leftJoin("conversations as c", "c.conversation_id", "s.primary_conversation_id")
      .select([
        "s.session_scope as session_scope",
        "s.chat_type as chat_type",
        "s.channel as channel",
        "s.account_id as account_id",
        "s.primary_conversation_id as primary_conversation_id",
        "c.kind as conversation_kind",
        "c.peer_id as conversation_peer_id",
        "c.thread_id as conversation_thread_id",
      ])
      .where("s.session_key", "=", options.sessionKey),
  );
  return row
    ? {
        sessionScope: optionalString(row.session_scope),
        chatType: optionalString(row.chat_type),
        channel: optionalString(row.channel),
        accountId: optionalString(row.account_id),
        primaryConversationId: optionalString(row.primary_conversation_id),
        conversationKind: optionalString(row.conversation_kind),
        conversationPeerId: optionalString(row.conversation_peer_id),
        conversationThreadId: optionalThreadId(row.conversation_thread_id),
      }
    : undefined;
}

export function deleteSqliteSessionEntry(
  options: SqliteSessionEntriesOptions & { sessionKey: string },
): boolean {
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_entries")
        .select("session_id")
        .where("session_key", "=", options.sessionKey),
    );
    if (!row) {
      return false;
    }
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("sessions").where("session_id", "=", row.session_id),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, options);
}

export function listSqliteSessionEntries(
  options: SqliteSessionEntriesOptions,
): Array<{ sessionKey: string; entry: SessionEntry }> {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    selectSessionEntryRows(db).orderBy("s.updated_at", "desc").orderBy("se.session_key", "asc"),
  ).rows;
  return rows.flatMap((row) => {
    const entry = projectTypedSessionColumns(row);
    return entry ? [{ sessionKey: row.session_key, entry }] : [];
  });
}

export function loadSqliteSessionEntries(
  options: SqliteSessionEntriesOptions,
): Record<string, SessionEntry> {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    selectSessionEntryRows(db).orderBy("se.session_key", "asc"),
  ).rows;
  const entries: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = projectTypedSessionColumns(row);
    if (entry) {
      entries[row.session_key] = entry;
    }
  }
  normalizeSessionEntries(entries);
  return entries;
}

export function mergeSqliteSessionEntries(
  options: SqliteSessionEntriesOptions,
  incoming: Record<string, SessionEntry>,
): { imported: number; stored: number } {
  normalizeSessionEntries(incoming);
  const existing = loadSqliteSessionEntries(options);
  const upsertEntries: Record<string, SessionEntry> = {};
  for (const [key, entry] of Object.entries(incoming)) {
    const current = existing[key];
    if (!current || resolveSessionEntryUpdatedAt(entry) >= resolveSessionEntryUpdatedAt(current)) {
      upsertEntries[key] = entry;
      existing[key] = entry;
    }
  }
  applySqliteSessionEntriesPatch({
    ...options,
    upsertEntries,
  });
  return {
    imported: Object.keys(incoming).length,
    stored: Object.keys(existing).length,
  };
}

function resolveSessionEntryUpdatedAt(entry: SessionEntry): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}
