import { readSessionMethodAccess } from "../../lib/session-method-access.ts";

/** Opening a local draft is not session creation; submission still requires live access. */
export function readNewSessionNavigationAccess(
  snapshot: Parameters<typeof readSessionMethodAccess>[0],
) {
  const access = readSessionMethodAccess(snapshot, {
    method: "sessions.create",
    params: {},
    sessionScope: true,
  });
  return snapshot?.phase === "reconnecting"
    ? { allowed: true as const, requiredScope: access.requiredScope }
    : access;
}

export type NewSessionRouteData = {
  /** The agent the loader resolved; empty until the Gateway can name one. */
  agentId: string;
  /** The agent the URL asked for, which only a navigation can change. */
  requestedAgentId: string;
  catalogId: string;
  /** An explicit model for this unsent draft, separate from saved preferences. */
  requestedModel?: string;
  group?: string;
  groupStatus?: "resolved" | "missing" | "unavailable";
  groupCwd?: string;
  groupWorktree?: boolean;
  groupCatalogGeneration?: number;
  groupDefaultsStatus?: import("../../lib/sessions/session-capability.ts").SessionGroupDefaultsStatus;
  model: string;
  catalogLabel: string;
  startTerminal: boolean;
  terminalHosts?: Array<{ hostId: string; label: string }>;
};

export type NewSessionTarget =
  | { catalogId: string; group?: never }
  | { group: string; catalogId?: never };

export function newSessionSearch(agentId: string, target?: NewSessionTarget): string {
  const params = new URLSearchParams();
  if (agentId) {
    params.set("agent", agentId);
  }
  if (target?.catalogId) {
    params.set("catalog", target.catalogId);
  }
  if (target?.group) {
    params.set("group", target.group);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function newSessionLocationFromSearch(
  search: string,
): Pick<NewSessionRouteData, "agentId" | "catalogId" | "group"> {
  const params = new URLSearchParams(search);
  return {
    agentId: params.get("agent")?.trim() ?? "",
    catalogId: params.get("catalog")?.trim() ?? "",
    group: params.get("group")?.trim() ?? "",
  };
}
