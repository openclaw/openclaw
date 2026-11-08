import type { ApplicationContext } from "../app/context.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";

export function loadSidebarAgentSelection(
  host: AppSidebarSessionNavigationElement,
  agentId: string,
  context: ApplicationContext,
  isIntentCurrent: () => boolean,
  expandAgent: (agentId: string) => void,
  sessionMainKey: () => string,
) {
  const selected = context.agentSelection.state.selectedId;
  const route = host.activeRouteId;
  const session = host.getRouteSessionKey();
  const query = JSON.stringify(host.sessionData.sessionListQuery(agentId));
  const connection = context.sessions.captureConnectionScope();
  const isCurrent = () =>
    isIntentCurrent() &&
    host.isConnected &&
    (connection
      ? context.sessions.isConnectionScopeCurrent(connection)
      : context.sessions.captureConnectionScope() === null) &&
    context.agentSelection.state.selectedId === selected &&
    host.activeRouteId === route &&
    host.getRouteSessionKey() === session &&
    JSON.stringify(host.sessionData.sessionListQuery(agentId)) === query;
  void import("./app-sidebar-agent-selection.ts")
    .then(({ switchSidebarChipAgent }) => {
      if (isCurrent()) {
        void switchSidebarChipAgent(host, agentId, context, isCurrent, expandAgent, sessionMainKey);
      }
    })
    .catch((error: unknown) => {
      if (isCurrent()) {
        void import("../lib/toast.ts").then(({ showToast }) => {
          showToast({ severity: "error", message: String(error) });
        });
      }
    });
}
