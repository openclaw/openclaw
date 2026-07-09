// Generic current-conversation bindings persist lightweight conversation ->
// session links for plugin channels without a custom binding adapter.
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeConversationText } from "../../acp/conversation-id.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingRecord,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

const CURRENT_BINDINGS_ID_PREFIX = "generic:";
const CURRENT_BINDING_CONVERSATION_KIND = "current";

type CurrentConversationBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

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
  if (record.expiresAt === undefined) {
    return false;
  }
  const expiresAt = asDateTimestampMs(record.expiresAt);
  if (expiresAt === undefined) {
    return true;
  }
  const nowMs = asDateTimestampMs(now);
  return nowMs !== undefined && !isFutureDateTimestampMs(expiresAt, { nowMs });
}

function normalizePersistedBindingRecord(
  record: SessionBindingRecord,
): SessionBindingRecord | null {
  if (!record?.bindingId || !record?.conversation?.conversationId || isBindingExpired(record)) {
    return null;
  }
  const conversation = normalizeConversationRef(record.conversation);
  const targetSessionKey = record.targetSessionKey?.trim() ?? "";
  if (!targetSessionKey) {
    return null;
  }
  return {
    ...record,
    bindingId: buildBindingId(conversation),
    targetSessionKey,
    conversation,
  };
}

function openBindingDatabase() {
  return openOpenClawStateDatabase();
}

function bindingRowsToRecords(rows: Array<{ record_json: string }>): SessionBindingRecord[] {
  return rows.flatMap((row) => {
    try {
      const parsed = JSON.parse(row.record_json) as SessionBindingRecord;
      const normalized = normalizePersistedBindingRecord(parsed);
      return normalized ? [normalized] : [];
    } catch {
      return [];
    }
  });
}

function readPersistedBindings(): SessionBindingRecord[] {
  const database = openBindingDatabase();
  const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(database.db);
  const now = Date.now();
  executeSqliteQuerySync(
    database.db,
    bindingDb
      .deleteFrom("current_conversation_bindings")
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", now),
  );
  const rows = executeSqliteQuerySync(
    database.db,
    bindingDb
      .selectFrom("current_conversation_bindings")
      .select(["record_json"])
      .orderBy("binding_id", "asc"),
  ).rows;
  return bindingRowsToRecords(rows);
}

function targetAgentIdForSessionKey(targetSessionKey: string): string {
  return resolveAgentIdFromSessionKey(targetSessionKey);
}

function writePersistedBindings(): void {
  const records = [...bindingsByConversationKey.values()]
    .filter((record) => !isBindingExpired(record))
    .toSorted((a, b) => a.bindingId.localeCompare(b.bindingId));
  const updatedAt = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
    executeSqliteQuerySync(db, bindingDb.deleteFrom("current_conversation_bindings"));
    if (records.length === 0) {
      return;
    }
    executeSqliteQuerySync(
      db,
      bindingDb.insertInto("current_conversation_bindings").values(
        records.map((record) => {
          const conversation = normalizeConversationRef(record.conversation);
          return {
            binding_key: buildConversationKey(conversation),
            binding_id: record.bindingId,
            target_agent_id: targetAgentIdForSessionKey(record.targetSessionKey),
            target_session_id: null,
            target_session_key: record.targetSessionKey,
            channel: conversation.channel,
            account_id: conversation.accountId,
            conversation_kind: CURRENT_BINDING_CONVERSATION_KIND,
            parent_conversation_id: conversation.parentConversationId ?? null,
            conversation_id: conversation.conversationId,
            target_kind: record.targetKind,
            status: record.status,
            bound_at: record.boundAt,
            expires_at: record.expiresAt ?? null,
            metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
            record_json: JSON.stringify(record),
            updated_at: updatedAt,
          };
        }),
      ),
    );
  });
}

function loadBindingsIntoMemory(): void {
  if (bindingsLoaded) {
    return;
  }
  bindingsLoaded = true;
  bindingsByConversationKey.clear();
  for (const record of readPersistedBindings()) {
    bindingsByConversationKey.set(buildConversationKey(record.conversation), record);
  }
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
  writePersistedBindings();
  return null;
}

function resolveChannelSupportsCurrentConversationBinding(params: {
  channel: string;
  accountId: string;
}): boolean {
  const normalized =
    normalizeAnyChannelId(params.channel) ??
    normalizeOptionalLowercaseString(normalizeConversationText(params.channel));
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
  const bindingSupport = plugin?.conversationBindings;
  if (bindingSupport?.supportsCurrentConversationBinding !== true) {
    return false;
  }
  return (
    bindingSupport.isCurrentConversationBindingSupported?.({ accountId: params.accountId }) ?? true
  );
}

function supportsGenericCurrentConversationBinding(ref: {
  channel: string;
  accountId: string;
}): boolean {
  const normalized = normalizeConversationRef({
    ...ref,
    conversationId: "capability-check",
  });
  return resolveChannelSupportsCurrentConversationBinding({
    channel: normalized.channel,
    accountId: normalized.accountId,
  });
}

function bindingRefFromId(bindingId: string): { channel: string; accountId: string } | null {
  if (!bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return null;
  }
  const [channel, accountId] = bindingId
    .slice(CURRENT_BINDINGS_ID_PREFIX.length)
    .split("\u241f", 2);
  return channel && accountId ? { channel, accountId } : null;
}

/** Reports generic current-conversation binding support for plugin-owned channels. */
export function getGenericCurrentConversationBindingCapabilities(params: {
  channel: string;
  accountId: string;
}): SessionBindingCapabilities | null {
  if (!supportsGenericCurrentConversationBinding(params)) {
    return null;
  }
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current"],
  };
}

/** Stores or replaces the current-conversation binding for a normalized conversation ref. */
export async function bindGenericCurrentConversation(
  input: SessionBindingBindInput,
): Promise<SessionBindingRecord | null> {
  const conversation = normalizeConversationRef(input.conversation);
  const targetSessionKey = input.targetSessionKey.trim();
  if (
    !conversation.channel ||
    !conversation.conversationId ||
    !targetSessionKey ||
    !supportsGenericCurrentConversationBinding(conversation)
  ) {
    return null;
  }
  loadBindingsIntoMemory();
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  if (now === undefined) {
    return null;
  }
  const ttlMs =
    typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
      ? Math.max(0, Math.floor(input.ttlMs))
      : undefined;
  const expiresAt =
    ttlMs === undefined
      ? undefined
      : ttlMs === 0
        ? now
        : resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNow });
  if (ttlMs !== undefined && expiresAt === undefined) {
    return null;
  }
  const key = buildConversationKey(conversation);
  const existing = pruneExpiredBinding(key);
  const record: SessionBindingRecord = {
    bindingId: buildBindingId(conversation),
    targetSessionKey,
    targetKind: input.targetKind,
    conversation,
    status: "active",
    boundAt: now,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    metadata: {
      ...existing?.metadata,
      ...input.metadata,
      lastActivityAt: now,
    },
  };
  bindingsByConversationKey.set(key, record);
  writePersistedBindings();
  return record;
}

/** Resolves a current-conversation binding and prunes it if its TTL has expired. */
export function resolveGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
  if (!supportsGenericCurrentConversationBinding(ref)) {
    return null;
  }
  return pruneExpiredBinding(buildConversationKey(ref));
}

/** Lists non-expired current-conversation bindings owned by one target session. */
export function listGenericCurrentConversationBindingsBySession(
  targetSessionKey: string,
): SessionBindingRecord[] {
  loadBindingsIntoMemory();
  const results: SessionBindingRecord[] = [];
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (
      !record ||
      record.targetSessionKey !== targetSessionKey ||
      !supportsGenericCurrentConversationBinding(record.conversation)
    ) {
      continue;
    }
    results.push(record);
  }
  return results;
}

/** Persists last-activity metadata for an existing generic current-conversation binding. */
export function touchGenericCurrentConversationBinding(bindingId: string, at = Date.now()): void {
  const bindingRef = bindingRefFromId(bindingId);
  if (!bindingRef || !supportsGenericCurrentConversationBinding(bindingRef)) {
    return;
  }
  loadBindingsIntoMemory();
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
  writePersistedBindings();
}

/** Removes generic current-conversation bindings by binding id or target session key. */
export async function unbindGenericCurrentConversationBindings(
  input: SessionBindingUnbindInput,
): Promise<SessionBindingRecord[]> {
  const removed: SessionBindingRecord[] = [];
  const normalizedBindingId = input.bindingId?.trim();
  const normalizedTargetSessionKey = input.targetSessionKey?.trim();
  if (normalizedBindingId?.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    const bindingRef = bindingRefFromId(normalizedBindingId);
    if (!bindingRef || !supportsGenericCurrentConversationBinding(bindingRef)) {
      return removed;
    }
    loadBindingsIntoMemory();
    const key = normalizedBindingId.slice(CURRENT_BINDINGS_ID_PREFIX.length);
    const record = pruneExpiredBinding(key);
    if (record) {
      bindingsByConversationKey.delete(key);
      removed.push(record);
      writePersistedBindings();
    }
    return removed;
  }
  if (!normalizedTargetSessionKey) {
    return removed;
  }
  loadBindingsIntoMemory();
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (
      !record ||
      record.targetSessionKey !== normalizedTargetSessionKey ||
      !supportsGenericCurrentConversationBinding(record.conversation)
    ) {
      continue;
    }
    bindingsByConversationKey.delete(key);
    removed.push(record);
  }
  if (removed.length > 0) {
    writePersistedBindings();
  }
  return removed;
}

export const testing = {
  resetCurrentConversationBindingsForTests(params?: {
    deletePersistedFile?: boolean;
    env?: NodeJS.ProcessEnv;
  }) {
    bindingsLoaded = false;
    bindingsByConversationKey.clear();
    if (params?.deletePersistedFile) {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
          executeSqliteQuerySync(db, bindingDb.deleteFrom("current_conversation_bindings"));
        },
        params.env ? { env: params.env } : undefined,
      );
    }
  },
};
