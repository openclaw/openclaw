import type { RouteLocation } from "@openclaw/uirouter";
import {
  agentRouteFromPath,
  INTERNAL_AGENT_PATH_PARAM,
  pathForAgentPanel,
  pathForRoute,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";
import { DEFAULT_AGENT_PANEL } from "../../lib/agents/panels.ts";

export type AgentsRouteLocation = ReturnType<typeof resolveAgentsRouteLocation>;

function legacyAgentId(params: URLSearchParams): string | null {
  const agentId = params.get("agent")?.trim() ?? "";
  return agentId && !agentId.includes("/") && agentId !== "." && agentId !== ".." ? agentId : null;
}

export function resolveAgentsRouteLocation(sourceLocation: RouteLocation, basePath = "") {
  const location = restoreBridgedRouteLocation(sourceLocation, INTERNAL_AGENT_PATH_PARAM);
  const pathRoute = agentRouteFromPath(location.pathname, basePath);
  const params = new URLSearchParams(location.search);
  const hadLegacyAgent = params.has("agent");
  const legacyAgent = legacyAgentId(params);
  params.delete("agent");
  const search = params.toString();
  const requestedAgentId = pathRoute?.agentId ?? legacyAgent;
  const canonicalPath = pathRoute
    ? pathForAgentPanel(
        pathRoute.agentId,
        pathRoute.invalidPanel ? null : pathRoute.panelSegment,
        basePath,
      )
    : requestedAgentId
      ? pathForAgentPanel(requestedAgentId, null, basePath)
      : pathForRoute("agents", basePath);
  const canonicalLocation =
    hadLegacyAgent || pathRoute?.invalidPanel
      ? {
          pathname: canonicalPath,
          search: search ? `?${search}` : "",
          hash: location.hash,
        }
      : undefined;
  return {
    location,
    requestedAgentId,
    panel: pathRoute?.panel ?? DEFAULT_AGENT_PANEL,
    ...(canonicalLocation ? { canonicalLocation } : {}),
  };
}
