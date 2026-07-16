import crypto from "node:crypto";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

export type ConversationDeliveryStatus =
  | "created"
  | "queued"
  | "sent"
  | "suppressed"
  | "rejected"
  | "unknown"
  | "replied";

export type ConversationDeliveryRecord = {
  operationId: string;
  conversationRef: string;
  messageHash: string;
  status: ConversationDeliveryStatus;
  preparedMessageId?: string;
  platformMessageId?: string;
  queueId?: string;
  rejectionError?: string;
  reply?: {
    messageId: string;
    replyToId?: string;
    threadId?: string;
    text: string;
    timestamp: number;
  };
  createdAt: number;
  updatedAt: number;
};

export type ConversationDeliveryStoreScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
};

type ConversationDeliveryRow = {
  conversation_id: string;
  created_at: number;
  message_hash: string;
  operation_id: string;
  platform_message_id: string | null;
  prepared_message_id: string | null;
  queue_id: string | null;
  rejection_error: string | null;
  reply_message_id: string | null;
  reply_text: string | null;
  reply_thread_id: string | null;
  reply_timestamp: number | null;
  reply_to_id: string | null;
  status: string;
  updated_at: number;
};

function resolveDatabaseOptions(scope: ConversationDeliveryStoreScope) {
  return toDatabaseOptions(
    resolveSqliteReadScope({
      agentId: scope.agentId,
      ...(scope.env ? { env: scope.env } : {}),
      ...(scope.storePath ? { storePath: scope.storePath } : {}),
    }),
  );
}

function normalizeOperationId(value: string): string {
  const operationId = value.trim();
  if (!operationId) {
    throw new Error("Conversation delivery operation id is required");
  }
  return operationId;
}

function hashMessage(message: string): string {
  return crypto.createHash("sha256").update(message).digest("hex");
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
    conversationRef: row.conversation_id,
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

export class ConversationDeliveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationDeliveryInputError";
  }
}

function selectOperation(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  operationId: string,
): ConversationDeliveryRecord | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    db.selectFrom("conversation_deliveries").selectAll().where("operation_id", "=", operationId),
  ).rows[0] as ConversationDeliveryRow | undefined;
  return row ? mapRow(row) : undefined;
}

/** Reads one durable conversation operation by its stable id. */
export function getConversationDeliveryOperation(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
): ConversationDeliveryRecord | undefined {
  const database = openOpenClawAgentDatabase(resolveDatabaseOptions(scope));
  return selectOperation(database, normalizeOperationId(operationId));
}

/** Creates one idempotent delivery operation or returns its authoritative prior state. */
export function beginConversationDeliveryOperation(
  scope: ConversationDeliveryStoreScope,
  params: {
    operationId: string;
    conversationRef: string;
    message: string;
    preparedMessageId?: string;
  },
): { created: boolean; record: ConversationDeliveryRecord } {
  const operationId = normalizeOperationId(params.operationId);
  const messageHash = hashMessage(params.message);
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const existing = selectOperation(database, operationId);
      if (existing) {
        if (
          existing.conversationRef !== params.conversationRef ||
          existing.messageHash !== messageHash
        ) {
          throw new ConversationDeliveryInputError(
            `Conversation delivery operation was reused with different input: ${operationId}`,
          );
        }
        return { created: false, record: existing };
      }
      const now = Date.now();
      const db = getSessionKysely(database.db);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("conversation_deliveries").values({
          operation_id: operationId,
          conversation_id: params.conversationRef,
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
    },
    resolveDatabaseOptions(scope),
    { operationLabel: "conversation-delivery.begin" },
  );
}

function updateConversationDeliveryOperation(
  scope: ConversationDeliveryStoreScope,
  params: {
    operationId: string;
    status: ConversationDeliveryStatus;
    queueId?: string | null;
    platformMessageId?: string | null;
    rejectionError?: string | null;
    reply?: ConversationDeliveryRecord["reply"];
    allowedFrom: readonly ConversationDeliveryStatus[];
  },
): ConversationDeliveryRecord {
  const operationId = normalizeOperationId(params.operationId);
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const current = selectOperation(database, operationId);
      if (!current) {
        throw new Error(`Conversation delivery operation not found: ${operationId}`);
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
            ...(params.rejectionError !== undefined
              ? { rejection_error: params.rejectionError }
              : {}),
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
    },
    resolveDatabaseOptions(scope),
    { operationLabel: `conversation-delivery.${params.status}` },
  );
}

export function markConversationDeliveryQueued(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  queueId: string,
): ConversationDeliveryRecord {
  return updateConversationDeliveryOperation(scope, {
    operationId,
    status: "queued",
    queueId,
    allowedFrom: ["created"],
  });
}

export function markConversationDeliverySent(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  platformMessageId?: string,
): ConversationDeliveryRecord {
  return updateConversationDeliveryOperation(scope, {
    operationId,
    status: "sent",
    ...(platformMessageId ? { platformMessageId } : {}),
    allowedFrom: ["created", "queued"],
  });
}

export function markConversationDeliverySuppressed(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
): ConversationDeliveryRecord {
  return updateConversationDeliveryOperation(scope, {
    operationId,
    status: "suppressed",
    allowedFrom: ["created", "queued"],
  });
}

export function markConversationDeliveryRejected(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
  rejectionError: string,
): ConversationDeliveryRecord {
  const normalizedError = rejectionError.trim();
  if (!normalizedError) {
    throw new Error("Conversation delivery rejection error is required");
  }
  return updateConversationDeliveryOperation(scope, {
    operationId,
    status: "rejected",
    rejectionError: normalizedError,
    allowedFrom: ["created", "queued"],
  });
}

export function markConversationDeliveryUnknown(
  scope: ConversationDeliveryStoreScope,
  operationId: string,
): ConversationDeliveryRecord {
  return updateConversationDeliveryOperation(scope, {
    operationId,
    status: "unknown",
    allowedFrom: ["created", "queued"],
  });
}

export function markConversationDeliveryReplied(
  scope: ConversationDeliveryStoreScope,
  params: {
    operationId: string;
    reply: NonNullable<ConversationDeliveryRecord["reply"]>;
  },
): ConversationDeliveryRecord {
  return updateConversationDeliveryOperation(scope, {
    operationId: params.operationId,
    status: "replied",
    reply: params.reply,
    allowedFrom: ["queued", "sent"],
  });
}

/** Finds the durable operation associated with an inbound transport reply. */
export function findConversationDeliveryByReplyTarget(
  scope: ConversationDeliveryStoreScope,
  params: { conversationRef: string; replyToId: string },
): ConversationDeliveryRecord | undefined {
  const database = openOpenClawAgentDatabase(resolveDatabaseOptions(scope));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("conversation_deliveries")
      .selectAll()
      .where("conversation_id", "=", params.conversationRef)
      .where((eb) =>
        eb.or([
          eb("platform_message_id", "=", params.replyToId),
          eb("prepared_message_id", "=", params.replyToId),
        ]),
      )
      .where("status", "in", ["queued", "sent", "replied"])
      .orderBy("updated_at", "desc")
      .limit(1),
  ).rows[0] as ConversationDeliveryRow | undefined;
  return row ? mapRow(row) : undefined;
}
