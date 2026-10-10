import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { Selectable } from "kysely";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { assertConversationAuthority } from "./conversation-authority.js";
import {
  ConversationDeliveryInputError,
  ConversationDeliveryMissingError,
  type ConversationDeliveryRecord,
  type ConversationDeliveryStatus,
  type ConversationDeliveryInput,
  type ConversationDeliveryBegin,
  type ConversationDeliveryTransition,
  type ConversationDeliveryLookup,
} from "./conversation-delivery-store.types.js";
import { resolveConversationInDatabase } from "./session-accessor.sqlite-conversation-read.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";

type ConversationDeliveryRow = Selectable<
  OpenClawAgentKyselyDatabase["conversation_deliveries"]
> & {
  channel: string;
};

function normalizeOperationId(value: string): string {
  const operationId = value.trim();
  if (!operationId) {
    throw new Error("Conversation delivery operation id is required");
  }
  return operationId;
}

function normalizeStatus(value: string): ConversationDeliveryStatus {
  switch (value) {
    case "created":
    case "queued":
    case "sent":
    case "suppressed":
    case "rejected":
    case "unknown":
    case "replied":
      return value;
    default:
      throw new Error(`Invalid conversation delivery status: ${value}`);
  }
}

function normalizeOperationKind(value: string): ConversationDeliveryRecord["operationKind"] {
  if (value === "send" || value === "turn") {
    return value;
  }
  throw new Error(`Invalid conversation delivery operation kind: ${value}`);
}

function mapRow(row: ConversationDeliveryRow): ConversationDeliveryRecord {
  const reply =
    row.reply_message_id && row.reply_text !== null && row.reply_timestamp !== null
      ? {
          messageId: row.reply_message_id,
          ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
          ...(row.reply_thread_id ? { threadId: row.reply_thread_id } : {}),
          text: row.reply_text,
          timestamp: row.reply_timestamp,
        }
      : undefined;
  return {
    operationId: row.operation_id,
    operationKind: normalizeOperationKind(row.operation_kind),
    conversationRef: row.conversation_id,
    channel: row.channel,
    ...(row.source_session_key ? { sourceSessionKey: row.source_session_key } : {}),
    messageHash: row.message_hash,
    status: normalizeStatus(row.status),
    ...(row.prepared_message_id ? { preparedMessageId: row.prepared_message_id } : {}),
    ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}),
    ...(row.queue_id ? { queueId: row.queue_id } : {}),
    ...(row.rejection_error ? { rejectionError: row.rejection_error } : {}),
    ...(reply ? { reply } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertConversationDeliveryInput(
  record: ConversationDeliveryRecord,
  input: ConversationDeliveryInput,
  messageHash = sha256Hex(input.message),
): void {
  if (
    record.conversationRef !== input.conversationRef ||
    record.operationKind !== input.operationKind ||
    record.sourceSessionKey !== (input.sourceSessionKey?.trim() || undefined) ||
    record.messageHash !== messageHash
  ) {
    throw new ConversationDeliveryInputError(
      `Conversation delivery operation was reused with different input: ${record.operationId}`,
    );
  }
}

const operationQuery = createSqliteQueryCache((database) => {
  const db = getSessionKysely(database);
  return prepareSqliteQuerySync<string, ConversationDeliveryRow>(database, (parameter) =>
    // Session pruning removes only session_conversations. The canonical
    // conversation row owns this delivery by foreign key and retains channel
    // identity even when no local session remains linked.
    db
      .selectFrom("conversation_deliveries as delivery")
      .innerJoin(
        "conversations as conversation",
        "conversation.conversation_id",
        "delivery.conversation_id",
      )
      .selectAll("delivery")
      .select("conversation.channel as channel")
      .where(
        "delivery.operation_id",
        "=",
        parameter((operationId) => operationId),
      ),
  );
});

function selectOperation(
  database: OpenClawAgentReadOnlyDatabase,
  operationId: string,
): ConversationDeliveryRecord | undefined {
  const row = operationQuery(database.db)(operationId).rows[0];
  return row ? mapRow(row) : undefined;
}

export function readConversationDeliveryInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  lookup: ConversationDeliveryLookup,
): ConversationDeliveryRecord | undefined {
  if (!("operationId" in lookup)) {
    return findConversationTurnDeliveryInDatabase(database, lookup);
  }
  const { operationId, expectedInput } = lookup;
  const record = selectOperation(database, normalizeOperationId(operationId));
  if (record && expectedInput) {
    assertConversationDeliveryInput(record, expectedInput);
  }
  return record;
}

export function beginConversationDeliveryInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  params: ConversationDeliveryBegin,
): { created: boolean; record: ConversationDeliveryRecord } {
  if (params.authority) {
    assertConversationAuthority(
      resolveConversationInDatabase(database, params.authority.conversationRef),
      params.authority,
    );
  }
  const operationId = normalizeOperationId(params.operationId);
  const sourceSessionKey = params.sourceSessionKey?.trim() || undefined;
  const messageHash = sha256Hex(params.message);
  const existing = selectOperation(database, operationId);
  if (existing) {
    assertConversationDeliveryInput(existing, params, messageHash);
    return { created: false, record: existing };
  }
  const now = Date.now();
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.insertInto("conversation_deliveries").values({
      operation_id: operationId,
      operation_kind: params.operationKind,
      conversation_id: params.conversationRef,
      source_session_key: sourceSessionKey ?? null,
      message_hash: messageHash,
      status: "created",
      prepared_message_id: params.preparedMessageId ?? null,
      platform_message_id: null,
      queue_id: null,
      rejection_error: null,
      reply_message_id: null,
      reply_to_id: null,
      reply_thread_id: null,
      reply_text: null,
      reply_timestamp: null,
      created_at: now,
      updated_at: now,
    }),
  );
  const record = selectOperation(database, operationId);
  if (!record) {
    throw new Error(`Conversation delivery operation was not persisted: ${operationId}`);
  }
  return { created: true, record };
}

export function transitionConversationDeliveryInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  params: ConversationDeliveryTransition,
): ConversationDeliveryRecord {
  if (params.session) {
    const { sessionKey, sessionId, lifecycleRevision } = params.session;
    const current = readSessionEntryRow(database, sessionKey)?.entry;
    if (current?.sessionId !== sessionId || current.lifecycleRevision !== lifecycleRevision) {
      throw new Error(`session changed before captured reply persistence: ${sessionKey}`);
    }
  }
  const operationId = normalizeOperationId(params.operationId);
  const current = selectOperation(database, operationId);
  if (!current) {
    throw new ConversationDeliveryMissingError(
      `Conversation delivery operation not found: ${operationId}`,
    );
  }
  if (!params.allowedFrom.includes(current.status)) {
    return current;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("conversation_deliveries")
      .set({
        status: params.status,
        ...(params.queueId !== undefined ? { queue_id: params.queueId } : {}),
        ...(params.platformMessageId !== undefined
          ? { platform_message_id: params.platformMessageId }
          : {}),
        ...(params.rejectionError !== undefined ? { rejection_error: params.rejectionError } : {}),
        ...(params.reply
          ? {
              reply_message_id: params.reply.messageId,
              reply_to_id: params.reply.replyToId ?? null,
              reply_thread_id: params.reply.threadId ?? null,
              reply_text: params.reply.text,
              reply_timestamp: params.reply.timestamp,
            }
          : {}),
        updated_at: Date.now(),
      })
      .where("operation_id", "=", operationId),
  );
  const record = selectOperation(database, operationId);
  if (!record) {
    throw new Error(`Conversation delivery operation disappeared: ${operationId}`);
  }
  return record;
}

function findConversationTurnDeliveryInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  params: { conversationRef: string; replyToId: string },
): ConversationDeliveryRecord | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("conversation_deliveries as delivery")
      .innerJoin(
        "conversations as conversation",
        "conversation.conversation_id",
        "delivery.conversation_id",
      )
      .selectAll("delivery")
      .select("conversation.channel as channel")
      .where("delivery.conversation_id", "=", params.conversationRef)
      .where("delivery.operation_kind", "=", "turn")
      .where((eb) =>
        eb.or([
          eb("delivery.platform_message_id", "=", params.replyToId),
          eb("delivery.prepared_message_id", "=", params.replyToId),
        ]),
      )
      .where("delivery.status", "in", ["queued", "sent", "replied"])
      .orderBy("delivery.updated_at", "desc")
      .limit(1),
  ).rows[0];
  return row ? mapRow(row) : undefined;
}
