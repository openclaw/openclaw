import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { isSessionRouteId, sameRouteLocation, type RouteId } from "../app-route-paths.ts";
import { selectRenderedRouteMatch } from "./router-outlet-controller.ts";

export type ShellRouteState = {
  routeId?: RouteId;
  routeFailed?: boolean;
  location?: RouteLocation;
  committedRouteId?: RouteId;
  committedLocation?: RouteLocation;
  committedSessionKey?: string;
};

function sessionKeyFromRouteData(routeId: RouteId, data: unknown): string | undefined {
  if (!isSessionRouteId(routeId) || !data || typeof data !== "object") {
    return undefined;
  }
  const record = data as { kind?: unknown; sessionKey?: unknown };
  return (
    (record.kind === "session" &&
      typeof record.sessionKey === "string" &&
      record.sessionKey.trim()) ||
    undefined
  );
}

export function selectShellRouteState(routerState: RouterState<RouteId>): ShellRouteState {
  const match = selectRenderedRouteMatch(routerState.matches[0], routerState.pendingMatches[0]);
  const committedMatch = routerState.matches[0];
  const committedSessionKey = committedMatch
    ? sessionKeyFromRouteData(committedMatch.routeId, committedMatch.data)
    : undefined;
  return {
    routeId: match?.routeId,
    location: match?.location,
    routeFailed: match
      ? match.status === "error" || match.status === "notFound"
      : routerState.status === "notFound" || undefined,
    committedRouteId: committedMatch?.routeId,
    committedLocation: committedMatch?.location,
    committedSessionKey,
  };
}

export function equalShellRouteState(previous: ShellRouteState, next: ShellRouteState): boolean {
  return (
    previous.routeId === next.routeId &&
    previous.routeFailed === next.routeFailed &&
    sameRouteLocation(previous.location, next.location) &&
    previous.committedRouteId === next.committedRouteId &&
    sameRouteLocation(previous.committedLocation, next.committedLocation) &&
    previous.committedSessionKey === next.committedSessionKey
  );
}
