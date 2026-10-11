import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import type { AgentsListResult } from "../../api/types.ts";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-routes.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { selectableAgentsList } from "../../lib/agents/display.ts";
import { resolveAgentsRouteLocation, type AgentsRouteLocation } from "./route-location.ts";

export type AgentsRouteData = AgentsRouteLocation & {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  settingsAgentSelection: ApplicationContext["settingsAgentSelection"];
  selectionIntentRevision: number;
  agentsList: AgentsListResult | null;
};

export const page = definePage({
  ...routePageSpec("agents"),
  loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
    const route = resolveAgentsRouteLocation(location, context.basePath).location;
    return `${route.pathname}\u0000${route.search}\u0000${route.hash}\u0000${context.settingsAgentSelection.intentRevision}`;
  },
  // Cached selections must settle without a module-loading delay that retains stale controls.
  loader: async (context: ApplicationContext, { location }): Promise<AgentsRouteData> => {
    const route = resolveAgentsRouteLocation(location, context.basePath);
    const gateway = context.gateway;
    const gatewaySnapshot = gateway.snapshot;
    const settingsAgentSelection = context.settingsAgentSelection;
    const selectionIntentRevision = settingsAgentSelection.intentRevision;
    const rawAgentsList = context.agents.state.agentsList ?? (await context.agents.ensureList());
    return {
      ...route,
      gateway,
      gatewaySnapshot,
      settingsAgentSelection,
      selectionIntentRevision,
      agentsList: rawAgentsList ? selectableAgentsList(rawAgentsList) : null,
    };
  },
  component: () =>
    import("./agents-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<AgentsRouteData>) =>
        createComponent(module.AgentsPage, {
          get routeData() {
            return props.data;
          },
        }),
    })),
});
