import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import type { ThemeMode } from "../app/theme.ts";
import type { GatewayStatus } from "../lib/gateway-status.ts";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type {
  SidebarEmptyGroupsMode,
  SidebarRecentSession,
  SidebarSessionSortMode,
} from "./app-sidebar-session-types.ts";
import type { SessionDataOwner } from "./session-data.ts";
import type { SessionOrganizer } from "./session-organizer.ts";

export interface SidebarRouteView {
  readonly activeRouteId?: NavigationRouteId;
  readonly basePath: string;
  readonly enabledRouteIds?: readonly NavigationRouteId[];
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;
  readonly sessionDataContext: ApplicationContext | undefined;
  getRouteSessionKey(): string;
}

export interface SidebarMenusOwner extends SidebarRouteView {
  sessionsGrouping: SidebarSessionsGrouping;
  sessionsShowCron: boolean;
  sessionsShowPreview: boolean;
  sessionsShowSystem: boolean;
  sessionsStatusFilter: import("./app-sidebar-session-types.ts").SidebarSessionStatusFilter;
  clearSessionSelection(): void;
  knownSessionGroups(): string[];
  readonly nativeGatewaySnapshot: NativeGatewaysSnapshot | null;
  readonly canPairDevice: boolean;
  readonly connected: boolean;
  readonly connectionStatus: GatewayStatus | null;
  readonly gatewayVersion: string | null;
  readonly onPairMobile?: () => void;
  readonly onRetryConnect?: () => void;
  readonly onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;
  sidebarAgentsMode: "chip" | "roster";
  navigationView: "pages" | "sessions" | "online";
  readonly pinnedAgentIds: readonly string[];
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly sessionData: SessionDataOwner;
  readonly sessionOrganizer: SessionOrganizer;
  readonly people: import("./sidebar-people.ts").SidebarPeoplePreferences;
  readonly peopleView?: ReturnType<typeof import("./sidebar-people.ts").createSidebarPeople>;
  readonly sessionOwnerFilterActive: boolean;
  readonly sessionOwnerFilterId: string | null;
  readonly sessionInvolvingMeFilterActive: boolean;
  readonly sessionOwnerOptions: readonly SessionOwnerOption[];
  readonly sessionOwnershipVisibility: { filters: boolean; avatars: boolean };
  readSessionMutationAccess(
    request: import("../lib/session-method-access.ts").SessionMethodAccessRequest,
  ): import("../lib/session-method-access.ts").SessionMethodAccess;
  readonly sidebarEntries: readonly string[];
  readonly catalogProjectGrouping: CatalogProjectGrouping;
  setCatalogProjectGrouping(grouping: CatalogProjectGrouping): void;
  hideSessionCatalog(catalogId: string): void;
  readonly sessionsEmptyGroupsMode: SidebarEmptyGroupsMode;
  setSessionsEmptyGroupsMode(mode: SidebarEmptyGroupsMode): void;
  effectiveSessionSortMode(): SidebarSessionSortMode;
  effectiveSessionsGrouping(): SidebarSessionsGrouping;
  sessionPeopleSortAvailable(): boolean;
  setSessionSortMode(mode: SidebarSessionSortMode): void;
  setSessionOwnerFilter(ownerId: string | null, involvingMe?: boolean): void;
  readonly terminalAvailable: boolean;
  readonly themeMode: ThemeMode;
  activeChipAgent(): {
    activeId: string;
    pending?: boolean;
    agent: GatewayAgentRow | undefined;
    agents: readonly GatewayAgentRow[];
    identity: AgentIdentityResult | null;
    identities: ReadonlyMap<string, AgentIdentityResult>;
  };
  agentUnreadCount(agentId: string): number;
  ensureAgentIdentities(agentIds: readonly string[]): void;
  findSidebarMenuSessionByKey(sessionKey: string): SidebarRecentSession | undefined;
  getSessionNavigationState(): { selectedAgentId: string };
  selectedVisibleSessions(): SidebarRecentSession[];
  switchChipAgent(agentId: string): void;
}
