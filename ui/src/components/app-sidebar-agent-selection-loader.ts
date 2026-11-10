import { lazyModule } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import type { AgentSelectionHost } from "./app-sidebar-agent-selection.ts";

const loadSelection = lazyModule(() => import("./app-sidebar-agent-selection.ts"));
const loadToast = lazyModule(() => import("../lib/toast.ts"));

export function loadSidebarAgentSelection(
  host: AgentSelectionHost,
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
  const load = async () => {
    try {
      const { switchSidebarChipAgent } = await loadSelection();
      if (isCurrent()) {
        await switchSidebarChipAgent(
          host,
          agentId,
          context,
          isCurrent,
          expandAgent,
          sessionMainKey,
        );
      }
    } catch (error) {
      if (isCurrent()) {
        try {
          const { showToast } = await loadToast();
          if (!isCurrent()) {
            return;
          }
          showToast({ severity: "error", message: String(error) });
        } catch (toastError) {
          console.error("Unable to report agent selection failure", toastError, error);
        }
      }
    }
  };
  void load();
}
