import type { DatabaseSync } from "node:sqlite";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../sqlite-transaction.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

export const CURRENT_BINDINGS_ID_PREFIX = "generic:";
const CURRENT_BINDING_CONVERSATION_KIND = "current";

type CurrentConversationBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

export type CurrentConversationBindingScope = { channel: string; accountId: string };
type CurrentConversationBindingRow = Pick<
  CurrentConversationBindingDatabase["current_conversation_bindings"],
  "binding_key" | "binding_id" | "target_session_key" | "record_json"
>;

function currentConversationBindingRow(
  record: SessionBindingRecord,
  conversation: ConversationRef,
  bindingKey: string,
) {
  return {
    binding_key: bindingKey,
    binding_id: record.bindingId,
    target_session_key: record.targetSessionKey,
    channel: conversation.channel,
    account_id: conversation.accountId,
    conversation_kind: "current",
    parent_conversation_id: conversation.parentConversationId ?? null,
    conversation_id: conversation.conversationId,
    target_kind: record.targetKind,
    status: record.status,
    bound_at: record.boundAt,
    expires_at: record.expiresAt ?? null,
    metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
    record_json: JSON.stringify(record),
    updated_at: Date.now(),
  };
}

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
const getCurrentConversationBindingQueries = createSqliteQueryCache(
  createCurrentConversationBindingQueries,
);

function buildConversationKey(ref: ConversationRef): string {
  return [ref.channel, ref.accountId, ref.parentConversationId ?? "", ref.conversationId].join(
    "\u241f",
  );
}

export function buildBindingId(ref: ConversationRef): string {
  return `${CURRENT_BINDINGS_ID_PREFIX}${buildConversationKey(ref)}`;
}

export function isBindingExpired(record: SessionBindingRecord, now = Date.now()): boolean {
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

export function bindingRowToRecord(row: { record_json: string }): SessionBindingRecord | null {
  try {
    // SAFETY: Rows use the binding writer's record shape; normalization rejects missing identity fields.
    const record = JSON.parse(row.record_json) as SessionBindingRecord;
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
  } catch {
    return null;
  }
}

function readCurrentConversationBinding(db: DatabaseSync, conversation: ConversationRef) {
  const bindingKey = buildConversationKey(conversation);
  const queries = getCurrentConversationBindingQueries(db);
  // Shipped self-parent rows have a stale key; use the existing conversation
  // index and normalize the candidate before accepting the same conversation.
  const row =
    queries.exact(bindingKey) ??
    queries.legacy(conversation).rows.find((candidate) => {
      const record = bindingRowToRecord(candidate);
      return record !== null && buildConversationKey(record.conversation) === bindingKey;
    });
  return { bindingKey, row, record: row ? bindingRowToRecord(row) : null };
}

export function deleteCurrentConversationBindingRow(db: DatabaseSync, bindingKey: string): void {
  getCurrentConversationBindingQueries(db).remove(bindingKey);
}

export function updateCurrentConversationBindingRecordInDatabase(
  db: DatabaseSync,
  ref: ConversationRef,
  update: (current: SessionBindingRecord | null) => SessionBindingRecord | null,
): { previous: SessionBindingRecord | null; current: SessionBindingRecord | null } {
  const conversation = normalizeConversationRef(ref);
  const {
    bindingKey,
    row: existingRow,
    record: existing,
  } = readCurrentConversationBinding(db, conversation);
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
}

export function inspectCurrentConversationBindingRecordInDatabase(
  db: DatabaseSync,
  conversation: ConversationRef,
  now = Date.now(),
): SessionBindingRecord | null {
  const { record } = readCurrentConversationBinding(db, conversation);
  return record && !isBindingExpired(record, now) ? record : null;
}

/** Higher-priority absences and later fallback rows must come from the same snapshot. */
export function readCurrentConversationBindingSelectionInDatabase(
  db: DatabaseSync,
  conversations: readonly ConversationRef[],
): Array<SessionBindingRecord | null> {
  return runSqliteDeferredTransactionSync(db, () => {
    const now = Date.now();
    return conversations.map((conversation) =>
      inspectCurrentConversationBindingRecordInDatabase(db, conversation, now),
    );
  });
}

export function readCurrentConversationBindingResolutionInDatabase(
  db: DatabaseSync,
  conversation: ConversationRef,
): { record: SessionBindingRecord | null; repair: boolean } {
  const { row, record } = readCurrentConversationBinding(db, conversation);
  return {
    record: record ?? null,
    repair: Boolean(
      row &&
      record &&
      (isBindingExpired(record) ||
        row.binding_key !== buildConversationKey(record.conversation) ||
        row.binding_id !== record.bindingId ||
        row.target_session_key !== record.targetSessionKey),
    ),
  };
}

export function listCurrentConversationBindingRowsBySession(
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

/** Warm listings avoid writer admission unless an expired record requires the existing repair. */
export function readCurrentConversationBindingListInDatabase(
  db: DatabaseSync,
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
): { records: SessionBindingRecord[]; requiresPrune: boolean } {
  const records = listCurrentConversationBindingRowsBySession(db, targetSessionKey, scope)
    .map(bindingRowToRecord)
    .filter((record) => record !== null);
  return { records, requiresPrune: records.some((record) => isBindingExpired(record)) };
}

/** Reread after writer admission; malformed rows keep the same expiry-triggered repair contract. */
export function pruneCurrentConversationBindingListInTransaction(
  db: DatabaseSync,
  targetSessionKey: string,
  scope?: CurrentConversationBindingScope,
): SessionBindingRecord[] {
  const rows = listCurrentConversationBindingRowsBySession(db, targetSessionKey, scope);
  const active: SessionBindingRecord[] = [];
  for (const row of rows) {
    const record = bindingRowToRecord(row);
    if (!record || isBindingExpired(record)) {
      deleteCurrentConversationBindingRow(db, row.binding_key);
    } else {
      active.push(record);
    }
  }
  return active;
}
