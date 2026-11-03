import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { getChannelPlugin, normalizeChannelId } from "./plugins/registry.js";

type ConversationTargetParams = {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
};

function normalizeConversationTargetParams(params: ConversationTargetParams): {
  channel?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId = normalizeOptionalStringifiedId(params.conversationId);
  const parentConversationId = normalizeOptionalStringifiedId(params.parentConversationId);
  return { channel, conversationId, parentConversationId };
}

function resolveConversationDeliveryTarget({
  channel,
  conversationId,
  parentConversationId,
}: ReturnType<typeof normalizeConversationTargetParams>):
  | { to?: string; threadId?: string }
  | undefined {
  if (!channel || !conversationId) {
    return undefined;
  }
  // A partial hook result owns its missing fields; only null/undefined requests generic fallback.
  return (
    getChannelPlugin(normalizeChannelId(channel) ?? channel)?.messaging?.resolveDeliveryTarget?.({
      conversationId,
      parentConversationId,
    }) ?? { to: `channel:${conversationId}` }
  );
}

/** Formats a conversation id into a target, including a fallback for thread-only hook results. */
export function formatConversationTarget(params: ConversationTargetParams): string | undefined {
  const normalized = normalizeConversationTargetParams(params);
  return (
    resolveConversationDeliveryTarget(normalized)?.to?.trim() ||
    (normalized.channel && normalized.conversationId
      ? `channel:${normalized.conversationId}`
      : undefined)
  );
}

export function deliveryContextFromConversation(
  conversation?: ConversationRef | null,
): DeliveryContext | undefined {
  if (!conversation) {
    return undefined;
  }
  const target = resolveConversationDeliveryTarget(normalizeConversationTargetParams(conversation));
  return normalizeDeliveryContext({
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: target?.to,
    threadId: target?.threadId,
  });
}
