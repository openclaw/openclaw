import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { assertConversationAuthority } from "./conversation-authority.js";
import {
  assertConversationDeliveryInput,
  normalizeConversationDeliveryOperationId,
} from "./conversation-delivery-policy.js";
import {
  ConversationDeliveryMissingError,
  type ConversationDeliveryBegin,
  type ConversationDeliveryLookup,
  type ConversationDeliveryRecord,
  type ConversationDeliveryTransition,
} from "./conversation-delivery-store.types.js";
import { selectSessionActorMemoryConversations } from "./session-actor-memory-conversation.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";

export function readSessionActorMemoryConversationDelivery(
  context: SessionActorMemoryStorageContext,
  lookup: ConversationDeliveryLookup,
): ConversationDeliveryRecord | undefined {
  if ("operationId" in lookup) {
    const record = context.conversations.deliveries.get(
      normalizeConversationDeliveryOperationId(lookup.operationId),
    );
    if (record && lookup.expectedInput) {
      assertConversationDeliveryInput(record, lookup.expectedInput);
    }
    return record;
  }
  let latest: ConversationDeliveryRecord | undefined;
  for (const record of context.conversations.deliveries.values()) {
    if (
      record.conversationRef === lookup.conversationRef &&
      record.operationKind === "turn" &&
      (record.platformMessageId === lookup.replyToId ||
        record.preparedMessageId === lookup.replyToId) &&
      (record.status === "queued" || record.status === "sent" || record.status === "replied") &&
      (!latest || record.updatedAt > latest.updatedAt)
    ) {
      latest = record;
    }
  }
  return latest;
}

export function beginSessionActorMemoryConversationDelivery(
  context: SessionActorMemoryStorageContext,
  params: ConversationDeliveryBegin,
): { created: boolean; record: ConversationDeliveryRecord } {
  const conversation = selectSessionActorMemoryConversations(context, {
    conversationRef: params.conversationRef,
    limit: 1,
  })[0];
  if (params.authority) {
    assertConversationAuthority(conversation, params.authority);
  }
  const operationId = normalizeConversationDeliveryOperationId(params.operationId);
  const existing = context.conversations.deliveries.get(operationId);
  if (existing) {
    assertConversationDeliveryInput(existing, params);
    return { created: false, record: existing };
  }
  if (!conversation) {
    throw new ConversationDeliveryMissingError(
      `Conversation delivery destination not found: ${params.conversationRef}`,
    );
  }
  const sourceSessionKey = params.sourceSessionKey?.trim() || undefined;
  const now = Date.now();
  const record: ConversationDeliveryRecord = {
    operationId,
    operationKind: params.operationKind,
    conversationRef: params.conversationRef,
    channel: conversation.channel,
    ...(sourceSessionKey ? { sourceSessionKey } : {}),
    messageHash: sha256Hex(params.message),
    status: "created",
    ...(params.preparedMessageId ? { preparedMessageId: params.preparedMessageId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  context.editConversations().deliveries.set(operationId, record);
  return { created: true, record };
}

export function transitionSessionActorMemoryConversationDelivery(
  context: SessionActorMemoryStorageContext,
  params: ConversationDeliveryTransition,
): ConversationDeliveryRecord {
  if (params.session) {
    const { sessionKey, sessionId, lifecycleRevision } = params.session;
    const entry = context.get(sessionKey)?.hot.entry;
    // Captured replies must not be attached to a replacement user conversation.
    if (entry?.sessionId !== sessionId || entry.lifecycleRevision !== lifecycleRevision) {
      throw new Error(`session changed before captured reply persistence: ${sessionKey}`);
    }
  }
  const operationId = normalizeConversationDeliveryOperationId(params.operationId);
  const current = context.conversations.deliveries.get(operationId);
  if (!current) {
    throw new ConversationDeliveryMissingError(
      `Conversation delivery operation not found: ${operationId}`,
    );
  }
  if (!params.allowedFrom.includes(current.status)) {
    return current;
  }
  const record: ConversationDeliveryRecord = {
    ...current,
    status: params.status,
    updatedAt: Date.now(),
  };
  for (const field of ["queueId", "platformMessageId", "rejectionError"] as const) {
    const value = params[field];
    if (value !== undefined) {
      if (value) {
        record[field] = value;
      } else {
        delete record[field];
      }
    }
  }
  if (params.reply) {
    if (params.reply.messageId) {
      record.reply = {
        messageId: params.reply.messageId,
        ...(params.reply.replyToId ? { replyToId: params.reply.replyToId } : {}),
        ...(params.reply.threadId ? { threadId: params.reply.threadId } : {}),
        text: params.reply.text,
        timestamp: params.reply.timestamp,
      };
    } else {
      delete record.reply;
    }
  }
  context.editConversations().deliveries.set(operationId, record);
  return record;
}
