import type { ReactiveControllerHost } from "lit";
import type { ControlUiNavigationItem } from "../../../src/plugin-sdk/control-ui.js";
import type { AgentIdentityResult } from "../api/types.ts";
import type { NavigationRouteId, SidebarZoneEntry } from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { ThemeMode } from "../app/theme.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type { ControlUiRegistration } from "../plugins/control-ui-capability.ts";
import type {
  SidebarEmptyGroupsMode,
  SidebarRecentSession,
  SidebarSessionSortMode,
} from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import type {
  SessionOrganizerController,
  SessionOrganizerControllerHost,
} from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";

type SidebarMenuAgent = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

export interface SidebarMenusControllerHost
  extends ReactiveControllerHost, SessionOrganizerControllerHost {
  readonly querySelector: HTMLElement["querySelector"];
  readonly activeRouteId?: NavigationRouteId;
  readonly basePath: string;
  readonly canPairDevice: boolean;
  readonly connected: boolean;
  readonly offline: boolean;
  readonly enabledRouteIds?: readonly NavigationRouteId[];
  readonly gatewayVersion: string | null;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;
  readonly onPairMobile?: () => void;
  readonly onRetryConnect?: () => void;
  readonly onUpdateSidebarEntries?: (entries: string[]) => void;
  readonly onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;
  sidebarAgentsMode: "chip" | "roster";
  readonly pinnedAgentIds: readonly string[];
  readonly preferencesBrowserOnly: boolean;
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly sessionData: SessionOrganizerControllerHost["sessionData"] &
    Pick<
      SessionDataController,
      | "approvalBadgeSnapshot"
      | "presenceInstanceId"
      | "presencePayload"
      | "sessionResultsByAgent"
      | "sessionsLoading"
      | "sessionsResult"
      | "archiveSessionCatalog"
      | "sessionScopeGeneration"
    >;
  readonly sessionDataContext: ApplicationContext<RouteId> | undefined;
  readonly sessionOrganizer: SessionOrganizerController;
  readonly sessionOwnerFilterActive: boolean;
  readonly sessionOwnerFilterId: string | null;
  readonly sessionInvolvingMeFilterActive: boolean;
  readonly sessionOwnerOptions: readonly SessionOwnerOption[];
  readonly sessionOwnershipVisible: boolean;
  readSessionMutationAccess(request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  }): import("../lib/session-method-access.ts").SessionMethodAccess;
  readonly sidebarHomePinned: boolean;
  readonly onUpdateSidebarHomePinned?: (pinned: boolean) => void;
  readonly sidebarEntries: readonly string[];
  readonly catalogProjectGrouping: CatalogProjectGrouping;
  setCatalogProjectGrouping(grouping: CatalogProjectGrouping): void;
  hideSessionCatalog(catalogId: string): void;
  sessionSortMode: SidebarSessionSortMode;
  readonly sessionsEmptyGroupsMode: SidebarEmptyGroupsMode;
  setSessionsEmptyGroupsMode(mode: SidebarEmptyGroupsMode): void;
  effectiveSessionSortMode(): SidebarSessionSortMode;
  effectiveSessionsGrouping(): SidebarSessionsGrouping;
  sessionPeopleSortAvailable(): boolean;
  setSessionSortMode(mode: SidebarSessionSortMode): void;
  setSessionOwnerFilter(ownerId: string | null, involvingMe?: boolean): void;
  readonly terminalAvailable: boolean;
  readonly themeMode: ThemeMode;
  pluginNavigation(): ControlUiRegistration<ControlUiNavigationItem>[];
  activeChipAgent(): {
    activeId: string;
    agent: SidebarMenuAgent | undefined;
    agents: readonly SidebarMenuAgent[];
    identity: AgentIdentityResult | null;
    identities: ReadonlyMap<string, AgentIdentityResult>;
  };
  ensureAgentIdentities(agentIds: readonly string[]): void;
  agentUnreadCount(agentId: string): number;
  askAgentCapabilities(agentId: string): void;
  getRouteSessionKey(): string;
  getSessionNavigationState(): { selectedAgentId: string };
  reconciledSidebarZone(): ReturnType<SessionOrganizerControllerHost["reconciledSidebarZone"]> & {
    entries: readonly SidebarZoneEntry[];
  };
  selectedVisibleSessions(): SidebarRecentSession[];
  switchChipAgent(agentId: string): void;
}
