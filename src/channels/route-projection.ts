// Projects bound conversations into channel delivery targets.
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { normalizeConversationTargetParams } from "../utils/conversation-target.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { getChannelPlugin, normalizeChannelId } from "./plugins/registry.js";

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

/** Resolves a persisted conversation reference directly into normalized delivery fields. */
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
