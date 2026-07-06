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

// Runs the durable write and, if it throws, restores the in-memory map to the
// pre-mutation snapshot before rethrowing. writePersistedBindings rewrites the
// whole table from the map, and bindingsLoaded is a one-time flag, so a failed
// write would otherwise leave a runtime-ahead map served until restart while the
// caller already saw the throw. Records are replaced wholesale (never mutated in
// place), so a shallow map copy captured before the mutation restores the exact
// last-persisted state.
function persistBindingsOrRestore(snapshot: Map<string, SessionBindingRecord>): void {
  try {
    writePersistedBindings();
  } catch (err) {
    bindingsByConversationKey.clear();
    for (const [key, record] of snapshot) {
      bindingsByConversationKey.set(key, record);
    }
    throw err;
  }
}

function loadBindingsIntoMemory(): void {
  if (bindingsLoaded) {
    return;
  }
  // Read before touching the cache: readPersistedBindings can throw (the durable
  // expired-row delete, the select, or opening the DB). Clearing the map and
  // flipping the one-time bindingsLoaded flag first would poison the cache on
  // failure, serving empty state until restart while the caller saw the error.
  const records = readPersistedBindings();
  bindingsByConversationKey.clear();
  for (const record of records) {
    bindingsByConversationKey.set(buildConversationKey(record.conversation), record);
  }
  bindingsLoaded = true;
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
  const snapshot = new Map(bindingsByConversationKey);
  bindingsByConversationKey.delete(key);
  persistBindingsOrRestore(snapshot);
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

/** Reports generic current-conversation binding support for plugin-owned channels. */
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

/** Stores or replaces the current-conversation binding for a normalized conversation ref. */
export async function bindGenericCurrentConversation(
  input: SessionBindingBindInput,
): Promise<SessionBindingRecord | null> {
  const conversation = normalizeConversationRef(input.conversation);
  const targetSessionKey = input.targetSessionKey.trim();
  if (!conversation.channel || !conversation.conversationId || !targetSessionKey) {
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
  const snapshot = new Map(bindingsByConversationKey);
  bindingsByConversationKey.set(key, record);
  persistBindingsOrRestore(snapshot);
  return record;
}

/** Resolves a current-conversation binding and prunes it if its TTL has expired. */
export function resolveGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
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
    if (!record || record.targetSessionKey !== targetSessionKey) {
      continue;
    }
    results.push(record);
  }
  return results;
}

/** Persists last-activity metadata for an existing generic current-conversation binding. */
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
  const snapshot = new Map(bindingsByConversationKey);
  bindingsByConversationKey.set(key, {
    ...record,
    metadata: {
      ...record.metadata,
      lastActivityAt: at,
    },
  });
  persistBindingsOrRestore(snapshot);
}

/** Removes generic current-conversation bindings by binding id or target session key. */
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
      const snapshot = new Map(bindingsByConversationKey);
      bindingsByConversationKey.delete(key);
      removed.push(record);
      persistBindingsOrRestore(snapshot);
    }
    return removed;
  }
  if (!normalizedTargetSessionKey) {
    return removed;
  }
  // pruneExpiredBinding inside the scan can persist its own expiry deletes, so
  // snapshot only after the scan settles: a snapshot taken before it would, on a
  // later batch-write failure, restore an expired binding the scan already
  // dropped from disk. Collect matches first, then snapshot, delete, and persist.
  const matches: Array<{ key: string; record: SessionBindingRecord }> = [];
  for (const key of bindingsByConversationKey.keys()) {
    const record = pruneExpiredBinding(key);
    if (!record || record.targetSessionKey !== normalizedTargetSessionKey) {
      continue;
    }
    matches.push({ key, record });
  }
  if (matches.length === 0) {
    return removed;
  }
  const snapshot = new Map(bindingsByConversationKey);
  for (const { key, record } of matches) {
    bindingsByConversationKey.delete(key);
    removed.push(record);
  }
  persistBindingsOrRestore(snapshot);
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
