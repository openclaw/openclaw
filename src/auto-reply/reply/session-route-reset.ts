import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { normalizeDeliveryChannelRoute } from "../../utils/delivery-context.shared.js";

export function stripThreadFromSessionRoute(
  route: ChannelRouteRef | undefined,
): ChannelRouteRef | undefined {
  const normalized = normalizeDeliveryChannelRoute(route);
  if (!normalized?.thread) {
    return normalized;
  }
  const { thread: _drop, ...withoutThread } = normalized;
  return Object.keys(withoutThread).length > 0 ? withoutThread : undefined;
}

export function stripThreadId<T extends { threadId?: string | number }>(
  context: T | undefined,
): Omit<T, "threadId"> | undefined {
  if (!context || context.threadId == null || context.threadId === "") {
    return context;
  }
  const { threadId: _threadId, ...rest } = context;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
