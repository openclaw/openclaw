import type { RouteLocation } from "@openclaw/uirouter";
import {
  INTERNAL_TERMINAL_PATH_PARAM,
  restoreBridgedRouteLocation,
  terminalSessionIdFromPath,
} from "../../app-route-paths.ts";
import type { TerminalRouteTarget } from "../../components/terminal/terminal-panel-session-types.ts";
import { catalogSessionKeyFromSearch } from "../../lib/sessions/catalog-key.ts";

export function resolveTerminalRouteLocation(
  source: RouteLocation,
  basePath = "",
): TerminalRouteTarget {
  const location = restoreBridgedRouteLocation(source, INTERNAL_TERMINAL_PATH_PARAM);
  const sessionId = terminalSessionIdFromPath(location.pathname, basePath);
  if (sessionId) {
    return { sessionId };
  }
  const catalog = catalogSessionKeyFromSearch(location.search);
  return catalog ? { catalog } : null;
}
