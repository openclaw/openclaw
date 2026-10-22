import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { isSessionRouteId, sameRouteLocation, type RouteId } from "../app-route-paths.ts";
import type { ChatRouteData } from "../pages/chat/session-route-data.ts";
import { selectRenderedRouteMatch } from "./router-outlet-presentation.ts";

export type ShellRouteState = {
  routeId?: RouteId;
  routeFailed?: boolean;
  sessionRouteNotice?: boolean;
  location?: RouteLocation;
  committedRouteId?: RouteId;
  committedLocation?: RouteLocation;
  committedSessionKey?: string;
};

function sessionKeyFromRouteData(routeId: RouteId, data: unknown): string | undefined {
  if (!isSessionRouteId(routeId)) {
    return undefined;
  }
  // SAFETY: Chat and Dashboard share the canonical session route loader.
  const record = data as ChatRouteData | undefined;
  return record?.kind === "session" ? record.sessionKey.trim() || undefined : undefined;
}

export function selectShellRouteState(routerState: RouterState<RouteId>): ShellRouteState {
  const match = selectRenderedRouteMatch(routerState.matches[0], routerState.pendingMatches[0]);
  const committedMatch = routerState.matches[0];
  const committedSessionKey = committedMatch
    ? sessionKeyFromRouteData(committedMatch.routeId, committedMatch.data)
    : undefined;
  const renderedSessionKey =
    match === committedMatch
      ? committedSessionKey
      : match && sessionKeyFromRouteData(match.routeId, match.data);
  return {
    routeId: match?.routeId,
    location: match?.location,
    routeFailed: match
      ? match.status === "error" || match.status === "notFound"
      : routerState.status === "notFound" || undefined,
    sessionRouteNotice:
      isSessionRouteId(match?.routeId) && match?.data !== undefined && !renderedSessionKey,
    committedRouteId: committedMatch?.routeId,
    committedLocation: committedMatch?.location,
    committedSessionKey,
  };
}

export function equalShellRouteState(previous: ShellRouteState, next: ShellRouteState): boolean {
  return (
    previous.routeId === next.routeId &&
    previous.routeFailed === next.routeFailed &&
    previous.sessionRouteNotice === next.sessionRouteNotice &&
    sameRouteLocation(previous.location, next.location) &&
    previous.committedRouteId === next.committedRouteId &&
    sameRouteLocation(previous.committedLocation, next.committedLocation) &&
    previous.committedSessionKey === next.committedSessionKey
  );
}
