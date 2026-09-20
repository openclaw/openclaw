// Generic current-conversation bindings persist lightweight conversation ->
// session links for plugin channels without a custom binding adapter.
import type { DatabaseSync } from "node:sqlite";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeConversationText } from "../../acp/conversation-id.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../kysely-sync.js";
import { currentConversationBindingRow } from "./current-conversation-binding-row.js";
import {
  buildChannelAccountKey,
  normalizeConversationRef,
} from "./session-binding-normalization.js";
import type {
  ConversationRef,
  SessionBindingBindInput,
  SessionBindingCapabilities,
  SessionBindingRecord,
  SessionBindingScope,
  SessionBindingUnbindInput,
} from "./session-binding.types.js";

const CURRENT_BINDINGS_ID_PREFIX = "generic:";
const CURRENT_BINDING_CONVERSATION_KIND = "current";

type CurrentConversationBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

type CurrentConversationBindingScope = { channel: string; accountId: string };
type CurrentConversationBindingRow = {
  binding_key: string;
  binding_id: string;
  target_session_key: string;
  record_json: string;
};

function createCurrentConversationBindingQueries(db: DatabaseSync) {
  const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
  const select = bindingDb
    .selectFrom("current_conversation_bindings")
    .select(["binding_key", "binding_id", "target_session_key", "record_json"]);
  function lists(genericOnly: boolean) {
    // Generic lookups must not load or decode rows belonging to account-owned adapters.
    const query = genericOnly
      ? select.where("binding_id", "like", `${CURRENT_BINDINGS_ID_PREFIX}%`)
      : select;
    return {
      bySession: prepareSqliteQuerySync<string, CurrentConversationBindingRow>(db, (parameter) =>
        query
          .where(
            "target_session_key",
            "=",
            parameter((target) => target),
          )
          .orderBy("binding_id", "asc"),
      ),
      byScope: prepareSqliteQuerySync<
        { targetSessionKey: string; scope: CurrentConversationBindingScope },
        CurrentConversationBindingRow
      >(db, (parameter) =>
        query
          .where(
            "target_session_key",
            "=",
            parameter((params) => params.targetSessionKey),
          )
          .where(
            "channel",
            "=",
            parameter((params) => params.scope.channel),
          )
          .where(
            "account_id",
            "=",
            parameter((params) => params.scope.accountId),
          )
          .orderBy("binding_id", "asc"),
      ),
    };
  }
  return {
    exact: prepareSqliteQueryTakeFirstSync<string, CurrentConversationBindingRow>(db, (parameter) =>
      select.where(
        "binding_key",
        "=",
        parameter((key) => key),
      ),
    ),
    legacy: prepareSqliteQuerySync<ConversationRef, CurrentConversationBindingRow>(
      db,
      (parameter) =>
        select
          .where(
            "channel",
            "=",
            parameter((conversation) => conversation.channel),
          )
          .where(
            "account_id",
            "=",
            parameter((conversation) => conversation.accountId),
          )
          .where("conversation_kind", "=", CURRENT_BINDING_CONVERSATION_KIND)
          .where(
            "conversation_id",
            "=",
            parameter((conversation) => conversation.conversationId),
          ),
    ),
    remove: prepareSqliteQuerySync<string>(db, (parameter) =>
      bindingDb.deleteFrom("current_conversation_bindings").where(
        "binding_key",
        "=",
        parameter((key) => key),
      ),
    ),
    upsert: prepareSqliteQuerySync<ReturnType<typeof currentConversationBindingRow>>(
      db,
      (parameter) => {
        const row = {
          binding_key: parameter((value) => value.binding_key),
          binding_id: parameter((value) => value.binding_id),
          target_session_key: parameter((value) => value.target_session_key),
          channel: parameter((value) => value.channel),
          account_id: parameter((value) => value.account_id),
          conversation_kind: parameter((value) => value.conversation_kind),
          parent_conversation_id: parameter((value) => value.parent_conversation_id),
          conversation_id: parameter((value) => value.conversation_id),
          target_kind: parameter((value) => value.target_kind),
          status: parameter((value) => value.status),
          bound_at: parameter((value) => value.bound_at),
          expires_at: parameter((value) => value.expires_at),
          metadata_json: parameter((value) => value.metadata_json),
          record_json: parameter((value) => value.record_json),
          updated_at: parameter((value) => value.updated_at),
        };
        return bindingDb
          .insertInto("current_conversation_bindings")
          .values(row)
          .onConflict((conflict) => conflict.column("binding_key").doUpdateSet(row));
      },
    ),
    generic: lists(true),
    all: lists(false),
  };
}

// Cache SQL templates per handle; native statements and their invalidation remain executor-owned.
const currentConversationBindingQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof createCurrentConversationBindingQueries>
>();

function getCurrentConversationBindingQueries(db: DatabaseSync) {
  let queries = currentConversationBindingQueries.get(db);
  if (!queries) {
    queries = createCurrentConversationBindingQueries(db);
    currentConversationBindingQueries.set(db, queries);
  }
  return queries;
}

function buildConversationKey(ref: ConversationRef): string {
  return [ref.channel, ref.accountId, ref.parentConversationId ?? "", ref.conversationId].join(
    "\u241f",
  );
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
  if (!record?.bindingId || !record?.conversation?.conversationId) {
    return null;
  }
  const conversation = normalizeConversationRef(record.conversation);
  const targetSessionKey = record.targetSessionKey?.trim() ?? "";
  if (!targetSessionKey) {
    return null;
  }
  return {
    ...record,
    bindingId: record.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)
      ? buildBindingId(conversation)
      : record.bindingId,
    targetSessionKey,
    conversation,
  };
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

function readCurrentConversationBindingRow(
  db: DatabaseSync,
  conversation: ConversationRef,
  bindingKey: string,
): CurrentConversationBindingRow | undefined {
  const queries = getCurrentConversationBindingQueries(db);
  const exact = queries.exact(bindingKey);
  if (exact) {
    return exact;
  }
  // Shipped self-parent rows have a stale key; use the existing conversation
  // index and normalize the candidate before accepting the same conversation.
  const candidates = queries.legacy(conversation).rows;
  return candidates.find((candidate) => {
    const record = bindingRowsToRecords([candidate])[0];
    return record !== undefined && buildConversationKey(record.conversation) === bindingKey;
  });
}

function deleteCurrentConversationBindingRow(db: DatabaseSync, bindingKey: string): void {
  getCurrentConversationBindingQueries(db).remove(bindingKey);
}

/** Updates one binding from its currently committed row in one synchronous transaction. */
export function updateCurrentConversationBindingRecord(
  ref: ConversationRef,
  update: (current: SessionBindingRecord | null) => SessionBindingRecord | null,
): { previous: SessionBindingRecord | null; current: SessionBindingRecord | null } {
  const conversation = normalizeConversationRef(ref);
  const bindingKey = buildConversationKey(conversation);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readCurrentConversationBindingRow(db, conversation, bindingKey);
    const existing = existingRow ? (bindingRowsToRecords([existingRow])[0] ?? null) : null;
    const previous = existing && !isBindingExpired(existing) ? existing : null;
    const current = update(previous);
    if (!current) {
      if (existingRow) {
        deleteCurrentConversationBindingRow(db, existingRow.binding_key);
      }
      return { previous, current: null };
    }

    if (buildConversationKey(normalizeConversationRef(current.conversation)) !== bindingKey) {
      throw new Error("Current conversation binding update changed its conversation owner");
    }
    if (existingRow && existingRow.binding_key !== bindingKey) {
      deleteCurrentConversationBindingRow(db, existingRow.binding_key);
    }
    const row = currentConversationBindingRow(current, conversation, bindingKey);
    getCurrentConversationBindingQueries(db).upsert(row);
    return { previous, current };
  });
}

/** Reads the latest durable binding and prunes only the exact expired conversation row. */
export function resolveCurrentConversationBindingRecord(
  ref: ConversationRef,
): SessionBindingRecord | null {
  const { db } = openOpenClawStateDatabase();
  const conversation = normalizeConversationRef(ref);
  const bindingKey = buildConversationKey(conversation);
  const row = readCurrentConversationBindingRow(db, conversation, bindingKey);
  if (!row) {
    return null;
  }
  const record = bindingRowsToRecords([row])[0];
  if (!record) {
    return null;
  }
  if (isBindingExpired(record)) {
    return updateCurrentConversationBindingRecord(conversation, (current) => current).current;
  }
  if (
    row.binding_key !== buildConversationKey(record.conversation) ||
    row.binding_id !== record.bindingId ||
    row.target_session_key !== record.targetSessionKey
  ) {
    return updateCurrentConversationBindingRecord(conversation, (current) => current).current;
  }
  return record;
}

function listCurrentConversationBindingRowsBySession(
  db: DatabaseSync,
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
  genericOnly = !scope,
): CurrentConversationBindingRow[] {
  const queries = getCurrentConversationBindingQueries(db);
  const list = genericOnly ? queries.generic : queries.all;
  if (scope) {
    const normalized = normalizeConversationRef({
      ...scope,
      conversationId: "binding-scope",
    });
    return list.byScope({ targetSessionKey, scope: normalized }).rows;
  }
  return list.bySession(targetSessionKey).rows;
}

/** Lists latest durable bindings using the exact target key and optional account scope. */
export function listCurrentConversationBindingRecordsBySession(
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
): SessionBindingRecord[] {
  const { db } = openOpenClawStateDatabase();
  const rows = listCurrentConversationBindingRowsBySession(db, targetSessionKey, scope);
  const records = bindingRowsToRecords(rows);
  if (!records.some((record) => isBindingExpired(record))) {
    return records;
  }
  return runOpenClawStateWriteTransaction(({ db: transactionDb }) => {
    const latestRows = listCurrentConversationBindingRowsBySession(
      transactionDb,
      targetSessionKey,
      scope,
    );
    const active: SessionBindingRecord[] = [];
    for (const row of latestRows) {
      const record = bindingRowsToRecords([row])[0];
      if (!record || isBindingExpired(record)) {
        deleteCurrentConversationBindingRow(transactionDb, row.binding_key);
      } else {
        active.push(record);
      }
    }
    return active;
  });
}

/** Deletes exact account-owned or generic session rows without disturbing sibling owners. */
export function deleteCurrentConversationBindingRecordsBySession(
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
  genericOnly = !scope,
): SessionBindingRecord[] {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const rows = listCurrentConversationBindingRowsBySession(
      db,
      targetSessionKey,
      scope,
      genericOnly,
    );
    const removed: SessionBindingRecord[] = [];
    for (const row of rows) {
      const record = bindingRowsToRecords([row])[0];
      if (genericOnly && !record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
        continue;
      }
      deleteCurrentConversationBindingRow(db, row.binding_key);
      if (record && !isBindingExpired(record)) {
        removed.push(record);
      }
    }
    return removed;
  });
}

function resolveChannelConversationBindingSupport(params: { channel: string; accountId: string }) {
  const normalized =
    normalizeAnyChannelId(params.channel) ??
    normalizeOptionalLowercaseString(normalizeConversationText(params.channel));
  if (!normalized) {
    return undefined;
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
  return plugin?.conversationBindings;
}

function resolveChannelSupportsCurrentConversationBinding(params: {
  channel: string;
  accountId: string;
}): boolean {
  const bindingSupport = resolveChannelConversationBindingSupport(params);
  if (
    bindingSupport?.supportsCurrentConversationBinding !== true ||
    bindingSupport.bindingStore === "adapter" ||
    typeof bindingSupport.createManager === "function"
  ) {
    return false;
  }
  return (
    bindingSupport.isCurrentConversationBindingSupported?.({ accountId: params.accountId }) ?? true
  );
}

/** True when an active channel lifecycle owns bindings through a registered adapter. */
export function requiresRegisteredSessionBindingAdapter(params: {
  channel: string;
  accountId: string;
}): boolean {
  const support = resolveChannelConversationBindingSupport(params);
  return support?.bindingStore === "adapter" || typeof support?.createManager === "function";
}

function supportsGenericCurrentConversationBinding(ref: {
  channel: string;
  accountId: string;
}): boolean {
  const normalized = normalizeConversationRef({
    ...ref,
    conversationId: "capability-check",
  });
  if (normalized.channel === INTERNAL_MESSAGE_CHANNEL) {
    return true;
  }
  return resolveChannelSupportsCurrentConversationBinding({
    channel: normalized.channel,
    accountId: normalized.accountId,
  });
}

function bindingRefFromId(bindingId: string, scope?: SessionBindingScope): ConversationRef | null {
  if (!bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return null;
  }
  const [channel, accountId, parentConversationId, conversationId] = bindingId
    .slice(CURRENT_BINDINGS_ID_PREFIX.length)
    .split("\u241f");
  if (!channel || !accountId || !conversationId) {
    return null;
  }
  if (scope && buildChannelAccountKey({ channel, accountId }) !== buildChannelAccountKey(scope)) {
    return null;
  }
  return {
    channel,
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  };
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
  return updateCurrentConversationBindingRecord(conversation, (existing) => ({
    bindingId: buildBindingId(conversation),
    targetSessionKey,
    targetKind: input.targetKind,
    conversation,
    status: "active",
    boundAt: now,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    metadata: {
      ...(existing?.targetSessionKey === targetSessionKey &&
      existing.targetKind === input.targetKind
        ? existing.metadata
        : undefined),
      ...input.metadata,
      lastActivityAt: now,
    },
  })).current;
}

/** Resolves a current-conversation binding and prunes it if its TTL has expired. */
export function resolveGenericCurrentConversationBinding(
  ref: ConversationRef,
): SessionBindingRecord | null {
  if (!supportsGenericCurrentConversationBinding(ref)) {
    return null;
  }
  const record = resolveCurrentConversationBindingRecord(ref);
  return record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) ? record : null;
}

/** Lists non-expired current-conversation bindings owned by one target session. */
export function listGenericCurrentConversationBindingsBySession(
  targetSessionKey: string,
): SessionBindingRecord[] {
  return listCurrentConversationBindingRecordsBySession(targetSessionKey).filter(
    (record) =>
      record.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX) &&
      supportsGenericCurrentConversationBinding(record.conversation),
  );
}

/** Persists last-activity metadata for an existing generic current-conversation binding. */
export function touchGenericCurrentConversationBinding(
  bindingId: string,
  at = Date.now(),
  scope?: SessionBindingScope,
): void {
  const conversation = bindingRefFromId(bindingId, scope);
  if (!conversation || !supportsGenericCurrentConversationBinding(conversation)) {
    return;
  }
  updateCurrentConversationBindingRecord(conversation, (current) =>
    current?.bindingId === bindingId
      ? {
          ...current,
          metadata: {
            ...current.metadata,
            lastActivityAt: at,
          },
        }
      : current,
  );
}

function unbindCurrentConversationBindingById(
  bindingId: string,
  scope?: SessionBindingScope,
): SessionBindingRecord[] {
  const conversation = bindingRefFromId(bindingId, scope);
  if (!conversation || !supportsGenericCurrentConversationBinding(conversation)) {
    return [];
  }
  const { previous, current } = updateCurrentConversationBindingRecord(conversation, (latest) =>
    latest?.bindingId === bindingId ? null : latest,
  );
  return previous && !current ? [previous] : [];
}

/** Removes generic current-conversation bindings by binding id or target session key. */
export async function unbindGenericCurrentConversationBindings(
  input: SessionBindingUnbindInput,
): Promise<SessionBindingRecord[]> {
  const normalizedBindingId = input.bindingId?.trim();
  if (normalizedBindingId?.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
    return unbindCurrentConversationBindingById(normalizedBindingId, input.scope);
  }
  const normalizedTargetSessionKey = input.targetSessionKey?.trim();
  return normalizedTargetSessionKey
    ? deleteCurrentConversationBindingRecordsBySession(
        normalizedTargetSessionKey,
        input.scope,
        true,
      )
    : [];
}

export const testing = {
  clearPersistedCurrentConversationBindingsForTests() {
    runOpenClawStateWriteTransaction(({ db }) => {
      const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
      executeSqliteQuerySync(db, bindingDb.deleteFrom("current_conversation_bindings"));
    });
  },
};
