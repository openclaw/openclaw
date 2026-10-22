import type { RouteLocation } from "@openclaw/uirouter";
import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveAgentsRouteLocation, type AgentsRouteLocation } from "./route-location.ts";

export type AgentsRouteData = AgentsRouteLocation & {
  settingsAgentSelection: ApplicationContext["settingsAgentSelection"];
  selectionIntentRevision: number;
};

export const page = defineSolidPage<"agents", ApplicationContext, AgentsRouteData>(
  "agents",
  () => import("./agents-page.tsx").then((module) => module.AgentsPage),
  {
    loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
      const route = resolveAgentsRouteLocation(location, context.basePath).location;
      return `${route.pathname}\u0000${route.search}\u0000${route.hash}\u0000${context.settingsAgentSelection.intentRevision}`;
    },
    // Cached selections must settle without a module-loading delay that retains stale controls.
    loader: async (context: ApplicationContext, { location }): Promise<AgentsRouteData> => {
      const route = resolveAgentsRouteLocation(location, context.basePath);
      const settingsAgentSelection = context.settingsAgentSelection;
      const selectionIntentRevision = settingsAgentSelection.intentRevision;
      if (!context.agents.state.agentsList) {
        await context.agents.ensureList();
      }
      return {
        ...route,
        settingsAgentSelection,
        selectionIntentRevision,
      };
    },
  },
);
