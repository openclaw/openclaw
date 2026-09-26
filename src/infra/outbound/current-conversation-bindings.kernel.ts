import type { DatabaseSync } from "node:sqlite";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../sqlite-transaction.js";
import { currentConversationBindingRow } from "./current-conversation-binding-row.js";
import { normalizeConversationRef } from "./session-binding-normalization.js";
import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

export const CURRENT_BINDINGS_ID_PREFIX = "generic:";
const CURRENT_BINDING_CONVERSATION_KIND = "current";

type CurrentConversationBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

export type CurrentConversationBindingScope = { channel: string; accountId: string };
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

export function bindingRowsToRecords(rows: Array<{ record_json: string }>): SessionBindingRecord[] {
  return rows.flatMap((row) => {
    try {
      // SAFETY: Rows use the binding writer's record shape; normalization rejects missing identity fields.
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

export function deleteCurrentConversationBindingRow(db: DatabaseSync, bindingKey: string): void {
  getCurrentConversationBindingQueries(db).remove(bindingKey);
}

export function updateCurrentConversationBindingRecordInDatabase(
  db: DatabaseSync,
  ref: ConversationRef,
  update: (current: SessionBindingRecord | null) => SessionBindingRecord | null,
): { previous: SessionBindingRecord | null; current: SessionBindingRecord | null } {
  const conversation = normalizeConversationRef(ref);
  const bindingKey = buildConversationKey(conversation);
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
}

export function inspectCurrentConversationBindingRecordInDatabase(
  db: DatabaseSync,
  conversation: ConversationRef,
  now = Date.now(),
): SessionBindingRecord | null {
  const row = readCurrentConversationBindingRow(
    db,
    conversation,
    buildConversationKey(conversation),
  );
  const record = row ? bindingRowsToRecords([row])[0] : undefined;
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
  const row = readCurrentConversationBindingRow(
    db,
    conversation,
    buildConversationKey(conversation),
  );
  const record = row ? bindingRowsToRecords([row])[0] : undefined;
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
  const records = bindingRowsToRecords(
    listCurrentConversationBindingRowsBySession(db, targetSessionKey, scope),
  );
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
    const record = bindingRowsToRecords([row])[0];
    if (!record || isBindingExpired(record)) {
      deleteCurrentConversationBindingRow(db, row.binding_key);
    } else {
      active.push(record);
    }
  }
  return active;
}
