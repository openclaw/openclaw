import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import {
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
} from "./channel-target-prefix.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

/** Compare the plugin-owned conversation grammar; do not create a parallel target parser. */
export function heartbeatExecRouteKey(
  route: DeliveryContext,
  plugin?: ChannelPlugin,
): string | undefined {
  const isGroup = plugin?.messaging?.inferTargetChatType?.({ to: route.to ?? "" }) !== "direct";
  const scopedConversation =
    route.threadId == null
      ? undefined
      : plugin?.messaging?.resolveInboundConversation?.({ to: String(route.threadId), isGroup });
  const resolveTarget = (conversation: typeof scopedConversation) =>
    conversation?.conversationId
      ? plugin?.messaging?.resolveDeliveryTarget?.({
          conversationId: conversation.conversationId,
          parentConversationId: conversation.parentConversationId,
        })
      : undefined;
  const scopedTarget = resolveTarget(scopedConversation);
  const normalizedThread = scopedTarget?.threadId ?? route.threadId;
  const conversation = plugin?.messaging?.resolveInboundConversation?.({
    to: route.to,
    threadId: normalizedThread,
    isGroup,
  });
  const target = resolveTarget(conversation);
  if (
    scopedTarget?.threadId != null &&
    scopedConversation?.conversationId !== conversation?.conversationId
  ) {
    return undefined;
  }
  const explicitThread = normalizedThread == null ? undefined : String(normalizedThread);
  if (target?.threadId != null && explicitThread != null && target.threadId !== explicitThread) {
    return undefined;
  }
  return channelRouteDedupeKey({
    channel: route.channel,
    accountId: route.accountId,
    to:
      conversation?.conversationId ??
      normalizeTargetForProvider(route.channel ?? "", route.to, plugin),
    threadId: target?.threadId ?? route.threadId,
  });
}

export function hasDeliverableHeartbeatTurnSource(
  turnSource: DeliveryContext | undefined,
): boolean {
  return Boolean(
    turnSource?.channel && isDeliverableMessageChannel(turnSource.channel) && turnSource.to?.trim(),
  );
}

export function isPositivelyDirectHeartbeatOwnerTarget(params: {
  plugin?: ChannelPlugin;
  to: string;
  chatType?: ChatType;
}): boolean {
  const to = params.plugin
    ? stripTargetProviderPrefix(
        params.to,
        params.plugin.id,
        ...(params.plugin.messaging?.targetPrefixes ?? []),
      )
    : params.to.trim();
  const chatType =
    normalizeChatType(params.chatType) ?? params.plugin?.messaging?.inferTargetChatType?.({ to });
  // Implicit delivery must prove a direct destination via the channel's own
  // classifier; syntax alone (even `user:`) never admits, so unclassified
  // shapes fail closed and operator alerts cannot escape into a shared chat.
  return chatType === "direct";
}

/** Canonicalize scoped topics using the channel's parser/serializer pair. */
export function normalizeHeartbeatExecRoute(
  route: DeliveryContext,
  plugin?: ChannelPlugin,
): DeliveryContext | undefined {
  const grammar = plugin?.messaging;
  if (
    !plugin ||
    !grammar?.resolveSessionConversation ||
    !grammar.resolveSessionTarget ||
    !route.to
  ) {
    return route;
  }
  const raw = stripOutboundTargetKindPrefix(
    stripTargetProviderPrefix(route.to, plugin.id, ...(grammar.targetPrefixes ?? [])),
  );
  const embedded = grammar.resolveSessionConversation({ kind: "group", rawId: raw });
  const explicit =
    route.threadId == null
      ? null
      : grammar.resolveSessionConversation({ kind: "group", rawId: String(route.threadId) });
  const id = embedded?.id ?? raw;
  if (
    explicit &&
    (explicit.id !== id || (embedded?.threadId && explicit.threadId !== embedded.threadId))
  ) {
    return undefined;
  }
  const threadId = embedded?.threadId ?? explicit?.threadId;
  if (!threadId) {
    return route;
  }
  const to = grammar.resolveSessionTarget({ kind: "group", id, threadId });
  if (!to) {
    return undefined;
  }
  const verified = grammar.resolveSessionConversation({ kind: "group", rawId: to });
  if (verified?.id !== id || verified.threadId !== threadId) {
    return undefined;
  }
  const target = grammar.resolveDeliveryTarget?.({ conversationId: to });
  if (route.threadId != null && !explicit && target?.threadId !== String(route.threadId)) {
    return undefined;
  }
  return { ...route, to, threadId: target?.threadId ?? route.threadId };
}
