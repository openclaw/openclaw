import type { ApplicationContext } from "../../app/context-types.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { canonicalMemoryRouteLocation } from "./memory-schema.ts";
import type { ConfigRouteData } from "./route-data.ts";

export function admitMemoryRoute(
  context: ApplicationContext,
  pageId: ConfigPageId,
  routeData: ConfigRouteData | null,
  normalizedLocation: string,
  recordNormalizedLocation: (location: string) => void,
) {
  if (pageId !== "memory") {
    recordNormalizedLocation("");
    return;
  }
  if (!routeData) {
    return;
  }
  const routeAgentId = new URLSearchParams(routeData.search).get("agent")?.trim();
  const intent = routeData.agentSelectionIntent;
  const agentSelection = context.settingsAgentSelection;
  if (
    routeAgentId &&
    intent?.owner === agentSelection &&
    intent.revision === agentSelection.intentRevision
  ) {
    agentSelection.set(routeAgentId);
  }
  const canonical = canonicalMemoryRouteLocation(routeData, context.basePath);
  if (!canonical) {
    recordNormalizedLocation("");
    return;
  }
  const source = `${routeData.pathname}${routeData.search}${routeData.hash}`;
  // Retained Settings data can repeat while the canonical replacement loads.
  if (normalizedLocation !== source) {
    recordNormalizedLocation(source);
    context.replace("memory", canonical);
  }
}
