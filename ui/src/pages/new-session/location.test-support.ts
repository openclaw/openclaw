import type { NewSessionRouteData } from "./location.ts";

export function createNewSessionRouteData(agentId = "main"): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId: "",
    catalogLabel: "",
    startTerminal: false,
  };
}
