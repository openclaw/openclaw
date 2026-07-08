import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { AgentsRouteData } from "./agents-page.ts";

async function loadAgentsRouteData(context: ApplicationContext): Promise<AgentsRouteData> {
  const gateway = context.gateway.snapshot;
  const agentsList = context.agents.state.agentsList;
  return {
    connected: gateway.connected,
    agentsList,
    selectedAgentId: agentsList?.defaultId ?? agentsList?.agents[0]?.id ?? null,
    error: context.agents.state.agentsError,
  };
}

export const page = definePage({
  id: "agents",
  path: "/agents",
  loader: loadAgentsRouteData,
  component: () =>
    import("./agents-page.ts").then(() => ({
      header: true,
      render: (data: AgentsRouteData | undefined) =>
        html`<openclaw-agents-page .routeData=${data}></openclaw-agents-page>`,
    })),
});
