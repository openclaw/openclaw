import type { SessionEntry, SessionOrigin } from "../config/sessions/types.js";
import type { ChannelRouteRef } from "../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "./delivery-context.types.js";

export type { DeliveryContext } from "./delivery-context.types.js";

/** Reads only the canonical persisted delivery record. */
export function deliveryContextFromSession(
  entry?: Pick<SessionEntry, "delivery">,
): DeliveryContext | undefined {
  return entry?.delivery?.kind === "external" ? entry.delivery.context : undefined;
}

export function sessionDeliveryRoute(
  entry?: Pick<SessionEntry, "delivery">,
): ChannelRouteRef | undefined {
  return entry?.delivery?.kind === "external" ? entry.delivery.route : undefined;
}

export function sessionDeliveryOrigin(
  entry?: Pick<SessionEntry, "delivery">,
): SessionOrigin | undefined {
  return entry?.delivery?.kind === "external" ? entry.delivery.origin : undefined;
}

export function sessionDeliveryChannel(entry?: Pick<SessionEntry, "delivery">): string | undefined {
  const delivery = entry?.delivery;
  return delivery?.kind === "external"
    ? (delivery.context.channel ?? delivery.origin.provider)
    : undefined;
}
