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

/** Normalize a route enough to prove it has both a channel and delivery target. */
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

/** Convert legacy delivery-context fields into the canonical channel route shape. */
export function routeFromDeliveryContext(context?: DeliveryContext): ChannelRouteRef | undefined {
  return channelRouteFromDeliveryContext(normalizeDeliveryContext(context));
}

/** Convert a channel route back into delivery-context fields used by older session records. */
export function deliveryContextFromRoute(route?: ChannelRouteRef): DeliveryContext | undefined {
  return deliveryContextFromChannelRoute(route);
}

/** Recover the best available route from a session, preferring canonical route metadata. */
export function routeFromSessionEntry(entry?: SessionEntry | null): ChannelRouteRef | undefined {
  if (!entry) {
    return undefined;
  }
  return (
    normalizeSessionDeliveryFields(entry).route ??
    routeFromDeliveryContext(deliveryContextFromSession(entry))
  );
}

/** Build the session persistence fields that mirror a canonical channel route. */
export function sessionDeliveryFieldsFromRoute(
  route?: ChannelRouteRef,
): SessionRouteDeliveryFields {
  return normalizeSessionDeliveryFields({ route });
}

/** Project a stored conversation reference through plugin-owned delivery target grammar. */
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
  return normalizeChannelRouteRef({
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: target.to,
    threadId: target.threadId,
    threadSource: target.threadId ? "target" : undefined,
  });
}

/** Project a conversation reference and require the result to be immediately routable. */
export function routableRouteFromConversationRef(
  conversation?: ConversationRef | null,
): RoutableChannelRouteRef | undefined {
  return normalizeRoutableChannelRoute(routeFromConversationRef(conversation));
}

/** Extract the conversation route from a session binding record. */
export function routeFromBindingRecord(
  binding?: SessionBindingRecord | null,
): ChannelRouteRef | undefined {
  return routeFromConversationRef(binding?.conversation);
}

/** Extract the binding route and require channel/target fields for delivery comparisons. */
export function routableRouteFromBindingRecord(
  binding?: SessionBindingRecord | null,
): RoutableChannelRouteRef | undefined {
  return normalizeRoutableChannelRoute(routeFromBindingRecord(binding));
}

/** Flatten route metadata for call sites that still accept delivery-context primitives. */
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

/** Compare two routes at the delivery target level, ignoring unknown account scope. */
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
    // Missing account id means the source was unscoped, not that accounts differ.
    (left.accountId == null || right.accountId == null || left.accountId === right.accountId) &&
    String(channelRouteThreadId(left) ?? "") === String(channelRouteThreadId(right) ?? "")
  );
}
