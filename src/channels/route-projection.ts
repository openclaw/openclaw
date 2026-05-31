import type { SessionEntry } from "../config/sessions/types.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import {
  channelRouteThreadId,
  channelRouteTarget,
  normalizeChannelRouteRef,
  type ChannelRouteChatType,
  type ChannelRouteRef,
} from "../plugin-sdk/channel-route.js";
import {
  channelRouteFromDeliveryContext,
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  resolveConversationDeliveryTarget,
  type DeliveryContext,
} from "../utils/delivery-context.js";

/** Channel route with the minimum fields needed for reply delivery. */
export type RoutableChannelRouteRef = ChannelRouteRef & {
  channel: string;
  target: {
    to: string;
    rawTo?: string;
    chatType?: ChannelRouteChatType;
  };
};

export type SessionRouteDeliveryFields = {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

/** Normalizes a route and narrows it to routes that carry a channel and target. */
export function normalizeRoutableChannelRoute(
  route?: ChannelRouteRef | null,
): RoutableChannelRouteRef | undefined {
  const normalized = normalizeChannelRouteRef({
    channel: route?.channel,
    accountId: route?.accountId,
    to: route?.target?.to,
    rawTo: route?.target?.rawTo,
    chatType: route?.target?.chatType,
    threadId: route?.thread?.id,
    threadKind: route?.thread?.kind,
    threadSource: route?.thread?.source,
  });
  if (!normalized?.channel || !normalized.target?.to) {
    return undefined;
  }
  return normalized as RoutableChannelRouteRef;
}

export function routeFromDeliveryContext(context?: DeliveryContext): ChannelRouteRef | undefined {
  return channelRouteFromDeliveryContext(normalizeDeliveryContext(context));
}

export function deliveryContextFromRoute(route?: ChannelRouteRef): DeliveryContext | undefined {
  return deliveryContextFromChannelRoute(route);
}

export function routeFromSessionEntry(entry?: SessionEntry | null): ChannelRouteRef | undefined {
  if (!entry) {
    return undefined;
  }
  return (
    // Canonical route wins over older delivery-context/last-* fields when sessions carry both.
    normalizeSessionDeliveryFields(entry).route ??
    routeFromDeliveryContext(deliveryContextFromSession(entry))
  );
}

export function sessionDeliveryFieldsFromRoute(
  route?: ChannelRouteRef,
): SessionRouteDeliveryFields {
  return normalizeSessionDeliveryFields({ route });
}

export function routeFromConversationRef(
  conversation?: ConversationRef | null,
): ChannelRouteRef | undefined {
  if (!conversation) {
    return undefined;
  }
  const target = resolveConversationDeliveryTarget({
    channel: conversation.channel,
    conversationId: conversation.conversationId,
    parentConversationId: conversation.parentConversationId,
  });
  // Plugin target projection can split a parent conversation into route target
  // plus thread id; that keeps later reply code transport-agnostic.
  return normalizeChannelRouteRef({
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: target.to,
    threadId: target.threadId,
    threadSource: target.threadId ? "target" : undefined,
  });
}

export function routableRouteFromConversationRef(
  conversation?: ConversationRef | null,
): RoutableChannelRouteRef | undefined {
  return normalizeRoutableChannelRoute(routeFromConversationRef(conversation));
}

export function routeFromBindingRecord(
  binding?: SessionBindingRecord | null,
): ChannelRouteRef | undefined {
  return routeFromConversationRef(binding?.conversation);
}

export function routableRouteFromBindingRecord(
  binding?: SessionBindingRecord | null,
): RoutableChannelRouteRef | undefined {
  return normalizeRoutableChannelRoute(routeFromBindingRecord(binding));
}

export function routeToDeliveryFields(route?: ChannelRouteRef): {
  deliveryContext?: DeliveryContext;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
} {
  const deliveryContext = deliveryContextFromRoute(route);
  return {
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(deliveryContext?.channel ? { channel: deliveryContext.channel } : {}),
    ...(deliveryContext?.to ? { to: deliveryContext.to } : {}),
    ...(deliveryContext?.accountId ? { accountId: deliveryContext.accountId } : {}),
    ...(deliveryContext?.threadId != null ? { threadId: deliveryContext.threadId } : {}),
  };
}

export function routesShareDeliveryTarget(params: {
  left?: ChannelRouteRef | null;
  right?: ChannelRouteRef | null;
}): boolean {
  const left = normalizeRoutableChannelRoute(params.left);
  const right = normalizeRoutableChannelRoute(params.right);
  if (!left || !right) {
    return false;
  }
  return (
    left.channel === right.channel &&
    channelRouteTarget(left) === channelRouteTarget(right) &&
    // Missing account ids are wildcards because older routes did not always persist them.
    (left.accountId == null || right.accountId == null || left.accountId === right.accountId) &&
    String(channelRouteThreadId(left) ?? "") === String(channelRouteThreadId(right) ?? "")
  );
}
