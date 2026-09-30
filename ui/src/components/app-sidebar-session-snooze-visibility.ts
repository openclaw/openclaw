import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { projectSidebarArchiveVisibility } from "./app-sidebar-session-archive-visibility.ts";
import { excludeSessionCatalogRows } from "./app-sidebar-session-catalog-state.ts";
import { projectSidebarSessionCatalogs } from "./app-sidebar-session-catalogs.ts";
import type { SidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarSessionStatusFilter } from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

type SidebarSnoozeVisibilityHost = {
  readonly sessionData: SessionDataController;
  readonly sessionDataContext: Pick<ApplicationContext, "sessions"> | undefined;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly hiddenSessionCatalogIds: ReadonlySet<string>;
  expandedAgentId(): string;
};

// Shares root and adopted-catalog snooze visibility and deadline inputs with their existing owners.
export function visibleSidebarSessionCatalogs(host: SidebarSnoozeVisibilityHost) {
  return host.sessionsStatusFilter === "archived" || host.sessionsStatusFilter === "snoozed"
    ? []
    : excludeSessionCatalogRows(
        host.sessionData.sessionCatalogs,
        host.sessionData.pendingCatalogArchives,
      ).filter((catalog) => !host.hiddenSessionCatalogIds.has(catalog.id));
}

export function sidebarCatalogLiveRows(sessionData: SessionDataController) {
  return [
    ...(sessionData.sessionsResult?.sessions ?? []),
    ...Object.values(sessionData.sessionResultsByAgent).flatMap((result) => result.sessions),
  ];
}

export function projectSidebarSnoozeCatalogs(
  host: SidebarSnoozeVisibilityHost,
  ownerId: string | null,
) {
  const visibility = projectSidebarArchiveVisibility({
    sessionData: host.sessionData,
    selectedAgentId: host.expandedAgentId(),
    statusFilter: host.sessionsStatusFilter,
    now: Date.now(),
    deletionState: (key, agentId) => host.sessionDataContext?.sessions.deletionState(key, agentId),
    archiveVisibility: (key) => host.sessionDataContext?.sessions.archiveVisibility(key),
  });
  return projectSidebarSessionCatalogs(
    visibleSidebarSessionCatalogs(host),
    ownerId,
    sidebarCatalogLiveRows(host.sessionData),
    visibility.isSessionHidden,
  );
}

export function sidebarSessionSnoozeWakeRows(
  sessionData: SessionDataController,
  selectedResult: SessionsListResult | null,
  navigationState: SidebarSessionNavigationState,
) {
  return [
    ...(selectedResult?.sessions ?? []),
    ...sidebarCatalogLiveRows(sessionData),
    ...navigationState.visibleSessionRows,
    ...(sessionData.activeSessionLineageRoot ? [sessionData.activeSessionLineageRoot] : []),
  ];
}
