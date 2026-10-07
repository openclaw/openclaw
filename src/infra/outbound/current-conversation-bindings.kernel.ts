import type { DatabaseSync } from "node:sqlite";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isPluginOwnedBindingMetadata } from "../../plugins/conversation-binding-metadata.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { registerNodeSqliteDisposeCallback } from "../kysely-sync-cache-state.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  encodeSqliteStringSet,
  sqliteStringSetEntries,
} from "../kysely-sync.js";
import {
  getSqliteReadOperationRevision,
  type SqliteReadOperationRevision,
} from "../sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../sqlite-transaction.js";
import type {
  CurrentConversationBindingBind,
  CurrentConversationBindingRemove,
} from "./current-conversation-bindings.worker-contract.js";
import { SessionBindingError } from "./session-binding-errors.js";
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

const MAX_RETAINED_BINDING_SELECTION = 128;
const retainedSelections = new WeakMap<
  DatabaseSync,
  {
    revision: SqliteReadOperationRevision;
    conversations: string;
    rows: Array<CurrentConversationBindingRow | undefined>;
  }
>();

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
    selection: prepareSqliteQuerySync<
      readonly ConversationRef[],
      CurrentConversationBindingRow & { request_index: number; is_exact: number }
    >(db, (parameter) => {
      const encoded = parameter((conversations) =>
        encodeSqliteStringSet(
          conversations.flatMap((ref) => [
            buildConversationKey(ref),
            ref.channel,
            ref.accountId,
            ref.conversationId,
          ]),
        ),
      );
      const fields = sqliteStringSetEntries(encoded).as("field");
      const requested = bindingDb.with("requested", (query) =>
        query
          .selectFrom(fields)
          .select((eb) => {
            const component = (index: number) =>
              eb.fn.max<string>(
                eb
                  .case()
                  .when(eb("field.key", "%", 4), "=", index)
                  .then(eb.ref("field.value"))
                  .end(),
              );
            return [
              eb.cast<number>(eb("field.key", "/", 4), "integer").as("request_index"),
              component(0).as("binding_key"),
              component(1).as("channel"),
              component(2).as("account_id"),
              component(3).as("conversation_id"),
            ];
          })
          .groupBy((eb) => eb.cast<number>(eb("field.key", "/", 4), "integer")),
      );
      const columns = [
        "requested.request_index",
        "candidate.binding_key",
        "candidate.binding_id",
        "candidate.target_session_key",
        "candidate.record_json",
      ] as const;
      return requested
        .selectFrom("requested")
        .innerJoin(
          "current_conversation_bindings as candidate",
          "candidate.binding_key",
          "requested.binding_key",
        )
        .select(columns)
        .select((eb) => eb.val(1).as("is_exact"))
        .unionAll((selection) =>
          selection
            .selectFrom("requested")
            .innerJoin("current_conversation_bindings as candidate", (join) =>
              join
                .onRef("candidate.channel", "=", "requested.channel")
                .onRef("candidate.account_id", "=", "requested.account_id")
                .onRef("candidate.conversation_id", "=", "requested.conversation_id")
                .on("candidate.conversation_kind", "=", CURRENT_BINDING_CONVERSATION_KIND),
            )
            .select(columns)
            .select((eb) => eb.val(0).as("is_exact"))
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("current_conversation_bindings as exact")
                    .select("exact.binding_key")
                    .whereRef("exact.binding_key", "=", "requested.binding_key"),
                ),
              ),
            ),
        )
        .orderBy("request_index");
    }),
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

function bindingRowToRecord(row: { record_json: string }): SessionBindingRecord | null {
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

function readCurrentConversationBindingRows(
  db: DatabaseSync,
  conversations: readonly ConversationRef[],
): Array<CurrentConversationBindingRow | undefined> {
  if (conversations.length === 0) {
    return [];
  }
  const revision =
    conversations.length <= MAX_RETAINED_BINDING_SELECTION
      ? getSqliteReadOperationRevision(db)
      : undefined;
  const selectionKey = revision
    ? JSON.stringify(
        conversations.map((ref) => [
          ref.channel,
          ref.accountId,
          ref.parentConversationId ?? "",
          ref.conversationId,
        ]),
      )
    : undefined;
  const retained = retainedSelections.get(db);
  if (revision && retained?.revision === revision && retained.conversations === selectionKey) {
    return retained.rows;
  }
  const selected = new Map<number, CurrentConversationBindingRow>();
  for (const row of getCurrentConversationBindingQueries(db).selection(conversations).rows) {
    if (selected.has(row.request_index)) {
      continue;
    }
    const conversation = conversations[row.request_index]!;
    const record = row.is_exact ? undefined : bindingRowToRecord(row);
    if (
      row.is_exact ||
      (record && buildConversationKey(record.conversation) === buildConversationKey(conversation))
    ) {
      selected.set(row.request_index, row);
    }
  }
  const rows = conversations.map((_, index) => selected.get(index));
  // Each phase still admits a fresh revision. Retain only row bytes, so expiry and
  // consumer metadata mutations cannot turn an earlier selection into authority.
  if (revision && selectionKey && getSqliteReadOperationRevision(db) === revision) {
    if (!retained) {
      const unregister = registerNodeSqliteDisposeCallback(db, () => {
        retainedSelections.delete(db);
        unregister();
      });
    }
    retainedSelections.set(db, { revision, conversations: selectionKey, rows });
  }
  return rows;
}

function readCurrentConversationBinding(db: DatabaseSync, conversation: ConversationRef) {
  const bindingKey = buildConversationKey(conversation);
  const row = readCurrentConversationBindingRows(db, [conversation])[0];
  return { bindingKey, row, record: row ? bindingRowToRecord(row) : null };
}

function deleteCurrentConversationBindingRow(db: DatabaseSync, bindingKey: string): void {
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

export function inspectCurrentConversationBindingRecordsInDatabase(
  db: DatabaseSync,
  conversations: readonly ConversationRef[],
  now = Date.now(),
): Array<SessionBindingRecord | null> {
  return readCurrentConversationBindingRows(db, conversations).map((row) => {
    const record = row ? bindingRowToRecord(row) : null;
    return record && !isBindingExpired(record, now) ? record : null;
  });
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
    return inspectCurrentConversationBindingRecordsInDatabase(db, conversations);
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

/** Same-target refreshes preserve committed metadata; target replacements do not inherit it. */
export function bindCurrentConversationInDatabase(
  db: DatabaseSync,
  input: CurrentConversationBindingBind,
  admit?: (requiresAgentId: boolean) => void,
) {
  return updateCurrentConversationBindingRecordInDatabase(
    db,
    input.record.conversation,
    (current) => applyCurrentConversationBindingBind(current, input, admit),
  ).current;
}

export function applyCurrentConversationBindingBind(
  current: SessionBindingRecord | null,
  input: CurrentConversationBindingBind,
  admit?: (requiresAgentId: boolean) => void,
): SessionBindingRecord {
  const record = input.record;
  assertExpectedCurrentBinding(current, input.expected);
  const previous =
    current?.targetSessionKey === record.targetSessionKey &&
    current.targetKind === record.targetKind
      ? current
      : undefined;
  const metadata = { ...previous?.metadata, ...record.metadata };
  // JSON capture omits undefined values, but those own keys still clear an older value.
  for (const key of input.metadataKeys ?? []) {
    metadata[key] = record.metadata?.[key];
  }
  const declaredAgentId = normalizeOptionalString(record.metadata?.agentId);
  const previousAgentId =
    typeof previous?.metadata?.agentId === "string" ? previous.metadata.agentId : undefined;
  const requiresAgentId = Boolean(
    input.accountPolicy &&
    declaredAgentId === undefined &&
    previousAgentId === undefined &&
    !isPluginOwnedBindingMetadata(metadata),
  );
  admit?.(requiresAgentId);
  if (input.accountPolicy) {
    metadata.agentId =
      declaredAgentId ??
      previousAgentId ??
      (requiresAgentId ? input.accountPolicy.inferredAgentId : undefined);
    for (const key of ["label", "boundBy"] as const) {
      metadata[key] =
        normalizeOptionalString(record.metadata?.[key]) ??
        (typeof previous?.metadata?.[key] === "string" ? previous.metadata[key] : undefined);
    }
  }
  return { ...record, metadata };
}

export function removeCurrentConversationBindingsInDatabase(
  db: DatabaseSync,
  input: CurrentConversationBindingRemove,
): SessionBindingRecord[] {
  if ("conversation" in input) {
    const { previous, current } = updateCurrentConversationBindingRecordInDatabase(
      db,
      input.conversation,
      (latest) => {
        assertExpectedCurrentBinding(latest, input.expected);
        return !input.bindingId || latest?.bindingId === input.bindingId ? null : latest;
      },
    );
    return previous && !current ? [previous] : [];
  }
  const rows = listCurrentConversationBindingRowsBySession(
    db,
    input.targetSessionKey,
    input.scope,
    input.genericOnly,
  );
  const removed: SessionBindingRecord[] = [];
  for (const row of rows) {
    const record = bindingRowToRecord(row);
    if (input.genericOnly && !record?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)) {
      continue;
    }
    deleteCurrentConversationBindingRow(db, row.binding_key);
    if (record && !isBindingExpired(record)) {
      removed.push(record);
    }
  }
  return removed;
}

function assertExpectedCurrentBinding(
  current: SessionBindingRecord | null,
  expected: SessionBindingRecord | null | undefined,
): void {
  if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new SessionBindingError(
      "BINDING_CREATE_FAILED",
      "Conversation binding changed before the operation could commit; retry against the current binding",
    );
  }
}
