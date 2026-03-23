import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { resolveConversationDeliveryTarget } from "../../utils/delivery-context.js";
import type { SessionBindingRecord } from "./session-binding-service.js";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveBoundConversationTarget(binding: SessionBindingRecord): {
  to?: string;
  threadId?: string | number;
} {
  const channel =
    normalizeChannelId(binding.conversation.channel) ?? binding.conversation.channel.trim();
  const pluginTarget = getChannelPlugin(channel)?.messaging?.resolveBoundDeliveryTarget?.({
    binding,
  });
  if (pluginTarget?.to) {
    return {
      to: normalizeText(pluginTarget.to) ?? pluginTarget.to,
      threadId: pluginTarget.threadId,
    };
  }
  return resolveConversationDeliveryTarget({
    channel: binding.conversation.channel,
    conversationId: binding.conversation.conversationId,
    parentConversationId: binding.conversation.parentConversationId,
  });
}
