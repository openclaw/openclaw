import type { RouteLocation } from "@openclaw/uirouter";
import {
  agentRouteFromPath,
  INTERNAL_AGENT_PATH_PARAM,
  pathForAgentPanel,
  pathForRoute,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";
import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { DEFAULT_AGENT_PANEL } from "../../lib/agents/panels.ts";

export type AgentsRouteData = ReturnType<typeof resolveAgentsRouteLocation> & {
  settingsAgentSelection: ApplicationContext["settingsAgentSelection"];
  selectionIntentRevision: number;
};

function resolveAgentsRouteLocation(sourceLocation: RouteLocation, basePath = "") {
  const location = restoreBridgedRouteLocation(sourceLocation, INTERNAL_AGENT_PATH_PARAM);
  const pathRoute = agentRouteFromPath(location.pathname, basePath);
  const params = new URLSearchParams(location.search);
  const hadLegacyAgent = params.has("agent");
  const legacyAgentId = params.get("agent")?.trim() ?? "";
  const legacyAgent =
    legacyAgentId && !legacyAgentId.includes("/") && legacyAgentId !== "." && legacyAgentId !== ".."
      ? legacyAgentId
      : null;
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
