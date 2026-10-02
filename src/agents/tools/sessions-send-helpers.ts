import {
  getChannelPlugin,
  normalizeChannelId as normalizeAnyChannelId,
} from "../../channels/plugins/index.js";
import { resolveSessionConversationRef } from "../../channels/plugins/session-conversation.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import { parseSessionDeliveryRoute } from "../../sessions/session-key-utils.js";

export type SessionDeliveryTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string; // Forum topic/thread ID
};

export function resolveSessionDeliveryTargetFromKey(
  sessionKey: string,
): SessionDeliveryTarget | null {
  const parsed = resolveSessionConversationRef(sessionKey);
  if (!parsed) {
    const directRoute = parseSessionDeliveryRoute(sessionKey);
    if (!directRoute || (directRoute.peerKind !== "direct" && directRoute.peerKind !== "dm")) {
      return null;
    }

    const normalizedChannel =
      normalizeAnyChannelId(directRoute.channel) ?? normalizeChatChannelId(directRoute.channel);
    const channel = normalizedChannel ?? directRoute.channel;
    const messaging = normalizedChannel
      ? getChannelPlugin(normalizedChannel)?.messaging
      : undefined;
    // Session peers are canonical; adapters restore API casing at their boundary.
    // Channel-style resolvers must not turn an explicit direct user into a room.
    const resolvedTarget =
      messaging?.directTargetStyle === "user-prefixed"
        ? undefined
        : messaging?.resolveDeliveryTarget?.({ conversationId: directRoute.peerId });
    const directTarget = `user:${directRoute.peerId}`;

    return {
      channel,
      to: resolvedTarget?.to?.trim() || messaging?.normalizeTarget?.(directTarget) || directTarget,
      ...(directRoute.accountId ? { accountId: directRoute.accountId } : {}),
      threadId: resolvedTarget?.threadId ?? directRoute.threadId,
    };
  }
  const normalizedChannel =
    normalizeAnyChannelId(parsed.channel) ?? normalizeChatChannelId(parsed.channel);
  const channel = normalizedChannel ?? parsed.channel;
  const plugin = normalizedChannel ? getChannelPlugin(normalizedChannel) : null;
  const genericTarget = parsed.kind === "channel" ? `channel:${parsed.id}` : `group:${parsed.id}`;
  // Prefer plugin-owned target normalization so channel-specific IDs and topics survive routing.
  const normalized =
    plugin?.messaging?.resolveSessionTarget?.({
      kind: parsed.kind,
      id: parsed.id,
      threadId: parsed.threadId,
    }) ?? plugin?.messaging?.normalizeTarget?.(genericTarget);
  return {
    channel,
    to: normalized ?? (normalizedChannel ? genericTarget : parsed.id),
    threadId: parsed.threadId,
  };
}
