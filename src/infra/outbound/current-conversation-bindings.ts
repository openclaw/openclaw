import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { normalizeConversationText } from "../../acp/conversation-id.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabaseOptions,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingRecord,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

type CurrentConversationBindingsTable =
  OpenClawStateKyselyDatabase["current_conversation_bindings"];
type CurrentConversationBindingRow = Selectable<CurrentConversationBindingsTable>;
type CurrentConversationBindingsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

const CURRENT_BINDINGS_ID_PREFIX = "generic:";

let bindingsLoaded = false;
const bindingsByConversationKey = new Map<string, SessionBindingRecord>();

function buildConversationKey(ref: ConversationRef): string {
  const normalized = normalizeConversationRef(ref);
  return [
    normalized.channel,
    normalized.accountId,
    normalized.parentConversationId ?? "",
    normalized.conversationId,
  ].join("\u241f");
}

function buildBindingId(ref: ConversationRef): string {
  return `${CURRENT_BINDINGS_ID_PREFIX}${buildConversationKey(ref)}`;
}

function isBindingExpired(record: SessionBindingRecord, now = Date.now()): boolean {
  return typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    ? record.expiresAt <= now
    : false;
}

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv = process.env): OpenClawStateDatabaseOptions {
  return {
    env,
  };
}

function getCurrentConversationBindingsKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CurrentConversationBindingsDatabase>(db);
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function recordToRow(record: SessionBindingRecord): Insertable<CurrentConversationBindingsTable> {
  const conversation = normalizeConversationRef(record.conversation);
  const bindingKey = buildConversationKey(conversation);
  const bindingId = buildBindingId(conversation);
  const normalized: SessionBindingRecord = {
    ...record,
    bindingId,
    conversation,
    targetSessionKey: record.targetSessionKey.trim(),
  };
  return {
    binding_key: bindingKey,
    binding_id: bindingId,
    channel: conversation.channel,
    account_id: conversation.accountId,
    parent_conversation_id: conversation.parentConversationId ?? null,
    conversation_id: conversation.conversationId,
    target_session_key: normalized.targetSessionKey,
    target_kind: normalized.targetKind,
    status: normalized.status,
    bound_at: normalized.boundAt,
    expires_at: normalized.expiresAt ?? null,
    metadata_json: serializeJson(normalized.metadata),
    record_json: JSON.stringify(normalized),
    updated_at: Date.now(),
  };
}

function rowToRecord(row: CurrentConversationBindingRow): SessionBindingRecord | null {
  const parsed = parseJsonRecord(row.record_json) ?? {};
  const conversation = normalizeConversationRef({
    channel: row.channel,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    ...(row.parent_conversation_id ? { parentConversationId: row.parent_conversation_id } : {}),
  });
  const targetSessionKey = row.target_session_key.trim();
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
    return null;
  }
  return {
    ...(parsed as Partial<SessionBindingRecord>),
    bindingId: buildBindingId(conversation),
    targetSessionKey,
    targetKind: row.target_kind === "subagent" ? "subagent" : "session",
    conversation,
    status:
      row.status === "ending" || row.status === "ended" || row.status === "active"
        ? row.status
        : "active",
    boundAt: normalizeNumber(row.bound_at) ?? 0,
    ...(row.expires_at != null ? { expiresAt: normalizeNumber(row.expires_at) } : {}),
    metadata: parseJsonRecord(row.metadata_json),
  };
}

function upsertBindingRow(record: SessionBindingRecord, env?: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getCurrentConversationBindingsKysely(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .insertInto("current_conversation_bindings")
        .values(recordToRow(record))
        .onConflict((conflict) =>
          conflict.column("binding_key").doUpdateSet({
            binding_id: (eb) => eb.ref("excluded.binding_id"),
            channel: (eb) => eb.ref("excluded.channel"),
            account_id: (eb) => eb.ref("excluded.account_id"),
            parent_conversation_id: (eb) => eb.ref("excluded.parent_conversation_id"),
            conversation_id: (eb) => eb.ref("excluded.conversation_id"),
            target_session_key: (eb) => eb.ref("excluded.target_session_key"),
            target_kind: (eb) => eb.ref("excluded.target_kind"),
            status: (eb) => eb.ref("excluded.status"),
            bound_at: (eb) => eb.ref("excluded.bound_at"),
            expires_at: (eb) => eb.ref("excluded.expires_at"),
            metadata_json: (eb) => eb.ref("excluded.metadata_json"),
            record_json: (eb) => eb.ref("excluded.record_json"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
          }),
        ),
    );
  }, sqliteOptionsForEnv(env));
}

function deleteBindingRow(key: string, env?: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getCurrentConversationBindingsKysely(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db.deleteFrom("current_conversation_bindings").where("binding_key", "=", key),
    );
  }, sqliteOptionsForEnv(env));
}

function loadBindingsIntoMemory(): void {
  if (bindingsLoaded) {
    return;
  }
  bindingsLoaded = true;
  bindingsByConversationKey.clear();
  const stateDatabase = openOpenClawStateDatabase();
  const db = getCurrentConversationBindingsKysely(stateDatabase.db);
  const rows = executeSqliteQuerySync(
    stateDatabase.db,
    db.selectFrom("current_conversation_bindings").selectAll().orderBy("updated_at", "asc"),
  ).rows;
  for (const row of rows) {
    const record = rowToRecord(row);
    if (!record?.bindingId || !record?.conversation?.conversationId || isBindingExpired(record)) {
      deleteBindingRow(row.binding_key);
      continue;
    }
    const conversation = normalizeConversationRef(record.conversation);
    const targetSessionKey = record.targetSessionKey?.trim() ?? "";
    if (!targetSessionKey) {
      continue;
    }
    bindingsByConversationKey.set(buildConversationKey(conversation), {
      ...record,
      bindingId: buildBindingId(conversation),
      targetSessionKey,
      conversation,
    });
  }
}

function persistBinding(record: SessionBindingRecord): void {
  upsertBindingRow(record);
}

function deletePersistedBinding(key: string): void {
  deleteBindingRow(key);
}

function pruneExpiredBinding(key: string): SessionBindingRecord | null {
  loadBindingsIntoMemory();
  const record = bindingsByConversationKey.get(key) ?? null;
  if (!record) {
    return null;
  }
  if (!isBindingExpired(record)) {
    return record;
  }
  bindingsByConversationKey.delete(key);
  deletePersistedBinding(key);
  return null;
}

function resolveChannelSupportsCurrentConversationBinding(channel: string): boolean {
  const normalized =
    normalizeAnyChannelId(channel) ??
    normalizeOptionalLowercaseString(normalizeConversationText(channel));
  if (!normalized) {
    return false;
  }
  const matchesPluginId = (plugin: {
    id?: string | null;
    meta?: { aliases?: readonly string[] } | null;
  }) =>
    plugin.id === normalized ||
    (plugin.meta?.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === normalized,
    );
  // Read the already-installed runtime channel registry from shared state only.
  // Importing plugins/runtime here creates a module cycle through plugin-sdk
  // surfaces during bundled channel discovery.
  const plugin = (getActivePluginChannelRegistryFromState()?.channels ?? []).find((entry) =>
    matchesPluginId(entry.plugin),
  )?.plugin;
  if (plugin?.conversationBindings?.supportsCurrentConversationBinding === true) {
    return true;
  }
  return false;
}

export function getGenericCurrentConversationBindingCapabilities(params: {
  channel: string;
  accountId: string;
}): SessionBindingCapabilities | null {
  void params.accountId;
  if (!resolveChannelSupportsCurrentConversationBinding(params.channel)) {
    return null;
  }
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current"],
  };
}

export async function bindGenericCurrentConversation(
  input: SessionBindingBindInput,
): Promise<SessionBindingRecord | null> {
  const conversation = normalizeConversationRef(input.conversation);
  const targetSessionKey = input.targetSessionKey.trim();
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
    return null;
  }
  loadBindingsIntoMemory();
  const now = Date.now();
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
      ? Math.max(0, Math.floor(input.ttlMs))
      : undefined;
  const key = buildConversationKey(conversation);
  const existing = pruneExpiredBinding(key);
  const record: SessionBindingRecord = {
    bindingId: buildBindingId(conversation),
    targetSessionKey,
    targetKind: input.targetKind,
    conversation,
    status: "active",
    boundAt: now,
    ...(ttlMs != null ? { expiresAt: now + ttlMs } : {}),
    metadata: {
      ...existing?.metadata,
      ...input.metadata,
      lastActivityAt: now,
    },
  };
  bindingsByConversationKey.set(key, record);
  persistBinding(record);
  return record;
}

export function resolveGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
  return pruneExpiredBinding(buildConversationKey(ref));
}

export function listGenericCurrentConversationBindingsBySession(
  targetSessionKey: string,
): SessionBindingRecord[] {
  loadBindingsIntoMemory();
  const results: SessionBindingRecord[] = [];
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (!record || record.targetSessionKey !== targetSessionKey) {
      continue;
    }
    results.push(record);
  }
  return results;
}

export function touchGenericCurrentConversationBinding(bindingId: string, at = Date.now()): void {
  loadBindingsIntoMemory();
  if (!bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return;
  }
  const key = bindingId.slice(CURRENT_BINDINGS_ID_PREFIX.length);
  const record = pruneExpiredBinding(key);
  if (!record) {
    return;
  }
  bindingsByConversationKey.set(key, {
    ...record,
    metadata: {
      ...record.metadata,
      lastActivityAt: at,
    },
  });
  persistBinding(bindingsByConversationKey.get(key)!);
}

export async function unbindGenericCurrentConversationBindings(
  input: SessionBindingUnbindInput,
): Promise<SessionBindingRecord[]> {
  loadBindingsIntoMemory();
  const removed: SessionBindingRecord[] = [];
  const normalizedBindingId = input.bindingId?.trim();
  const normalizedTargetSessionKey = input.targetSessionKey?.trim();
  if (normalizedBindingId?.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    const key = normalizedBindingId.slice(CURRENT_BINDINGS_ID_PREFIX.length);
    const record = pruneExpiredBinding(key);
    if (record) {
      bindingsByConversationKey.delete(key);
      removed.push(record);
      deletePersistedBinding(key);
    }
    return removed;
  }
  if (!normalizedTargetSessionKey) {
    return removed;
  }
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (!record || record.targetSessionKey !== normalizedTargetSessionKey) {
      continue;
    }
    bindingsByConversationKey.delete(key);
    deletePersistedBinding(key);
    removed.push(record);
  }
  return removed;
}

export const __testing = {
  resetCurrentConversationBindingsForTests(params?: {
    deletePersistedFile?: boolean;
    env?: NodeJS.ProcessEnv;
  }) {
    bindingsLoaded = false;
    bindingsByConversationKey.clear();
    if (params?.deletePersistedFile) {
      runOpenClawStateWriteTransaction((stateDatabase) => {
        const db = getCurrentConversationBindingsKysely(stateDatabase.db);
        executeSqliteQuerySync(stateDatabase.db, db.deleteFrom("current_conversation_bindings"));
      }, sqliteOptionsForEnv(params.env));
    }
  },
  persistBindingForTests(record: SessionBindingRecord, env?: NodeJS.ProcessEnv) {
    const conversation = normalizeConversationRef(record.conversation);
    const normalized: SessionBindingRecord = {
      ...record,
      bindingId: buildBindingId(conversation),
      conversation,
    };
    upsertBindingRow(normalized, env);
  },
};
