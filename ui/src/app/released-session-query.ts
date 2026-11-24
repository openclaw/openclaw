import type { RouteLocation } from "@openclaw/uirouter";
import type { AgentsListResult } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";

export function resolvePersistedAgentId(
  selectedAgentId: string | null | undefined,
  agentsList: AgentsListResult | null,
): string | null {
  const selectedId = selectedAgentId?.trim();
  if (!selectedId || !agentsList) {
    return null;
  }
  const normalizedId = normalizeAgentId(selectedId);
  return agentsList.agents.some((agent) => normalizeAgentId(agent.id) === normalizedId)
    ? normalizedId
    : null;
}

export function releasedSessionQuery(
  location: Pick<RouteLocation, "pathname" | "search">,
  basePath: string,
) {
  if (!location.search) {
    return null;
  }
  const params = new URLSearchParams(location.search);
  const session = params.get("session");
  if (session === null) {
    return null;
  }
  const root = location.pathname.replace(/\/$/u, "");
  const pathFace = (["chat", "dashboard"] as const).find(
    (face) => root === pathForRoute(face, basePath),
  );
  if (!pathFace) {
    return null;
  }
  const face = params.get("face") === "dashboard" ? "dashboard" : pathFace;
  const sessionKey = session.trim();
  params.delete("session");
  params.delete("face");
  return {
    face,
    sessionKey,
    search: params.size ? `?${params}` : "",
    path: (fallbackAgentId: string, mainKey?: string) =>
      pathForSession(face, fallbackAgentId, sessionKey, basePath, { mainKey }),
  };
}
