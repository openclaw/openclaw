import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { SessionEntry } from "../../config/sessions.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
  type GatewayMessageChannel,
} from "../../utils/message-channel.js";
import { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets.js";

export type AgentDeliveryPlan = {
  baseDelivery: SessionDeliveryTarget;
  resolvedChannel: GatewayMessageChannel;
  resolvedTo?: string;
  resolvedAccountId?: string;
  deliveryTargetMode?: ChannelOutboundTargetMode;
};

export function resolveAgentDeliveryPlan(params: {
  sessionEntry?: SessionEntry;
  requestedChannel?: string;
  explicitTo?: string;
  accountId?: string;
  wantsDelivery: boolean;
}): AgentDeliveryPlan {
  const requestedRaw =
    typeof params.requestedChannel === "string" ? params.requestedChannel.trim() : "";
  const normalizedRequested = requestedRaw ? normalizeMessageChannel(requestedRaw) : undefined;
  const requestedChannel = normalizedRequested || "last";

  const explicitTo =
    typeof params.explicitTo === "string" && params.explicitTo.trim()
      ? params.explicitTo.trim()
      : undefined;

  const baseDelivery = resolveSessionDeliveryTarget({
    entry: params.sessionEntry,
    requestedChannel: requestedChannel === INTERNAL_MESSAGE_CHANNEL ? "last" : requestedChannel,
    explicitTo,
  });

  const resolvedChannel = (() => {
    if (requestedChannel === INTERNAL_MESSAGE_CHANNEL) return INTERNAL_MESSAGE_CHANNEL;
    if (requestedChannel === "last") {
      if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
        return baseDelivery.channel;
      }
      return params.wantsDelivery ? DEFAULT_CHAT_CHANNEL : INTERNAL_MESSAGE_CHANNEL;
    }

    if (isGatewayMessageChannel(requestedChannel)) return requestedChannel;

    if (baseDelivery.channel && baseDelivery.channel !== INTERNAL_MESSAGE_CHANNEL) {
      return baseDelivery.channel;
    }
    return params.wantsDelivery ? DEFAULT_CHAT_CHANNEL : INTERNAL_MESSAGE_CHANNEL;
  })();

  const deliveryTargetMode = explicitTo
    ? "explicit"
    : isDeliverableMessageChannel(resolvedChannel)
      ? "implicit"
      : undefined;

  const resolvedAccountId =
    normalizeAccountId(params.accountId) ??
    (deliveryTargetMode === "implicit" ? baseDelivery.accountId : undefined);

  let resolvedTo = explicitTo;
  if (
    !resolvedTo &&
    isDeliverableMessageChannel(resolvedChannel) &&
    resolvedChannel === baseDelivery.lastChannel
  ) {
    resolvedTo = baseDelivery.lastTo;
  }

  return {
    baseDelivery,
    resolvedChannel,
    resolvedTo,
    resolvedAccountId,
    deliveryTargetMode,
  };
}
