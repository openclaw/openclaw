import type { RouteLocation } from "@openclaw/uirouter";
import { routeIdFromPath, sameRouteLocation } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";

/**
 * The channel a `/settings/channels?channel=<id>` link opens, so a link can name a setting
 * the channel's detail draws. Null when the location names none, or the destination did not change.
 */
export function linkedChannel(
  context: ApplicationContext,
  next: RouteLocation = context.router.getState().location,
  previous?: RouteLocation,
): string | null {
  const channel = new URLSearchParams(next.search).get("channel")?.trim() || null;
  return !sameRouteLocation(next, previous) &&
    routeIdFromPath(next.pathname, context.basePath) === "channels"
    ? channel
    : null;
}
