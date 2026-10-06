import type { RouteLoadCause } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { resolveAgentId, resolveCreateTarget } from "./catalog-target.ts";
import { takeInstantThreadRestore } from "./instant-thread-restore.ts";
import type { NewSessionRouteData } from "./location.ts";
import { newSessionModelLocationFromSearch } from "./model-location.ts";

export async function load(
  context: ApplicationContext,
  search: string,
  cause?: RouteLoadCause,
): Promise<NewSessionRouteData> {
  const restored = cause && cause !== "preload" && takeInstantThreadRestore(context, search);
  if (restored) {
    return restored;
  }
  const requestedLocation = newSessionModelLocationFromSearch(search);
  let groupCwd = "";
  let groupWorktree = false;
  let groupStatus: NewSessionRouteData["groupStatus"];
  let groupCatalogGeneration: number | undefined;
  let groupDefaultsStatus: NewSessionRouteData["groupDefaultsStatus"];
  if (requestedLocation.group) {
    const startedGeneration = context.sessions.groupsGeneration();
    const settings = await context.sessions.groupsLoad();
    groupCatalogGeneration = context.sessions.groupsGeneration();
    groupDefaultsStatus = context.sessions.groupsStatus();
    const currentSettings =
      startedGeneration === groupCatalogGeneration && groupDefaultsStatus === "ready"
        ? settings
        : null;
    const group = currentSettings?.find((candidate) => candidate.name === requestedLocation.group);
    groupStatus = currentSettings === null ? "unavailable" : group ? "resolved" : "missing";
    groupCwd = group?.cwd ?? "";
    groupWorktree = group?.worktree === true;
  }
  const route: NewSessionRouteData = {
    ...requestedLocation,
    requestedAgentId: requestedLocation.agentId,
    groupStatus,
    groupCwd,
    groupWorktree,
    groupCatalogGeneration,
    groupDefaultsStatus,
    catalogLabel: "",
    startTerminal: false,
  };
  if (!requestedLocation.catalogId) {
    return route;
  }
  const unresolved = (agentId = ""): NewSessionRouteData => ({ ...route, agentId });
  const initialGateway = context.gateway.snapshot;
  const initialAgentsState = context.agents.state;
  if (
    initialGateway.phase !== "connected" ||
    !initialGateway.client ||
    !initialAgentsState.connected ||
    initialAgentsState.client !== initialGateway.client
  ) {
    return unresolved();
  }
  // Current discovery must confirm catalog targets; unavailable rosters can retry.
  const loadedAgentsList = initialAgentsState.agentsList ?? (await context.agents.ensureList());
  const gateway = context.gateway.snapshot;
  const agentsState = context.agents.state;
  if (
    gateway.phase !== "connected" ||
    !gateway.client ||
    gateway.client !== initialGateway.client ||
    !agentsState.connected ||
    agentsState.client !== gateway.client ||
    !loadedAgentsList ||
    agentsState.agentsList !== loadedAgentsList
  ) {
    return unresolved();
  }
  const availableAgents = listSelectableAgents(loadedAgentsList.agents);
  const fallbackAgentId = availableAgents.some((agent) => agent.id === loadedAgentsList.defaultId)
    ? loadedAgentsList.defaultId
    : availableAgents[0]?.id;
  const agentId = fallbackAgentId
    ? resolveAgentId(requestedLocation, availableAgents, fallbackAgentId)
    : "";
  const plain = unresolved(agentId);
  if (!agentId) {
    return plain;
  }
  const target = await resolveCreateTarget(gateway.client, requestedLocation.catalogId, agentId);
  return target ? { ...plain, ...target } : plain;
}
