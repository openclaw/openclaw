import type { SessionEntry } from "../../config/sessions/types.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.read.js";
import {
  normalizeDeliveryChannelRoute,
  normalizeSessionDeliveryState,
} from "../../utils/delivery-context.shared.js";

export function withoutThreadDelivery(entry: SessionEntry | undefined) {
  if (entry?.delivery?.kind === "internal") {
    return entry.delivery;
  }
  return normalizeSessionDeliveryState({
    route: stripThreadFromSessionRoute(sessionDeliveryRoute(entry)),
    context: stripThreadId(deliveryContextFromSession(entry)),
    origin: stripThreadId(sessionDeliveryOrigin(entry)),
  });
}

function stripThreadFromSessionRoute(
  route: ChannelRouteRef | undefined,
): ChannelRouteRef | undefined {
  const normalized = normalizeDeliveryChannelRoute(route);
  if (!normalized?.thread) {
    return normalized;
  }
  const { thread: _drop, ...withoutThread } = normalized;
  return Object.keys(withoutThread).length > 0 ? withoutThread : undefined;
}

function stripThreadId<T extends { threadId?: string | number }>(
  context: T | undefined,
): Omit<T, "threadId"> | undefined {
  if (!context || context.threadId == null || context.threadId === "") {
    return context;
  }
  const { threadId: _threadId, ...rest } = context;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
