import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { formatUiError } from "../lib/format-error.ts";
import { buildAgentMainSessionKey } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import { personalSidebarAgentNavigationResult } from "./app-sidebar-personal-navigation.ts";
import { resolveLatestSidebarAgentSession } from "./app-sidebar-session-navigation-logic.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";

export async function switchSidebarChipAgent(
  host: AppSidebarSessionNavigationElement,
  agentId: string,
  context: ApplicationContext,
  isCurrent: () => boolean,
  expandAgent: (agentId: string) => void,
  sessionMainKey: () => string,
) {
  if (host.activeRouteId === "skills") {
    host.sidebarMenus.closeAgentMenu();
    expandAgent(agentId);
    return;
  }
  if (!host.connected) {
    host.sidebarMenus.closeAgentMenu();
    host.onNavigate?.("appearance");
    return;
  }
  const scope = context.sessions.captureConnectionScope();
  const query = host.sessionData.sessionListQuery(agentId);
  const selected = context.agentSelection.state.selectedId;
  const routeKey = host.getRouteSessionKey();
  const routeId = host.activeRouteId;
  host.sidebarMenus.closeAgentMenu();
  if (!scope) {
    return;
  }
  let result: SessionsListResult | null;
  try {
    result = await context.sessions.list(query);
  } catch (error) {
    if (isCurrent()) {
      showToast({ severity: "error", message: formatUiError(error) });
    }
    return;
  }
  if (
    !result ||
    !host.isConnected ||
    !host.connected ||
    !isCurrent() ||
    !context.sessions.isConnectionScopeCurrent(scope) ||
    context.agentSelection.state.selectedId !== selected ||
    host.getRouteSessionKey() !== routeKey ||
    host.activeRouteId !== routeId ||
    JSON.stringify(host.sessionData.sessionListQuery(agentId)) !== JSON.stringify(query)
  ) {
    return;
  }
  const projected = personalSidebarAgentNavigationResult(host, agentId, result);
  const latest = resolveLatestSidebarAgentSession({ agentId, result: projected, context });
  const resumeKey = latest?.key ?? buildAgentMainSessionKey({ agentId, mainKey: sessionMainKey() });
  expandAgent(agentId);
  host.selectSession(resumeKey);
}
