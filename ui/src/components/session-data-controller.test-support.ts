import type { ApplicationContext } from "../app/context.ts";
import type { SessionDataInputs } from "./session-data-catalog.ts";

export function createSessionDataHost(
  context: ApplicationContext,
  overrides: Partial<SessionDataInputs> = {},
) {
  return {
    isConnected: true,
    get connected() {
      return context.gateway.snapshot.phase === "connected";
    },
    activeRouteId: "sessions",
    sessionCatalogRowsVisible: true,
    navigationVisible: true,
    navigationView: "sessions",
    sidebarAgentsMode: "chip",
    shouldPublishSessionData: () => true,
    getRouteSessionKey: () => context.gateway.snapshot.sessionKey.trim(),
    childSessionParents: () => new Set<string>(),
    sessionDataContext: context,
    dismissTransientMenus: () => false,
    expandedAgentId: () => "main",
    promoteCreatedSession: () => undefined,
    selectedAgentIdForSessions: () => "main",
    sidebarSessionStatusFilter: () => "active",
    sidebarSessionOwnerFilter: () => ({ ownerId: null, involvingMe: false }),
    sessionCatalogIdsWithoutVisibleRows: () => [],
    samePresence: () => false,
    ...overrides,
  } satisfies SessionDataInputs;
}
