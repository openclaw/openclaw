import type { JSX as SolidJSX } from "@solidjs/web";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { NavigationRouteId, SidebarZoneEntry } from "../app-navigation.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import type { PresenceActivity } from "../lib/presence-users.ts";
import type {
  SessionMethodAccess,
  SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type { PersonalSessionGroup } from "../lib/sessions/personal-groups.ts";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type { ContributionsElement } from "../plugins/control-ui-contributions.solid.tsx";
import type {
  CatalogSessionMenuRequest,
  SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionPullRequestIndicators } from "./app-sidebar-session-pr-indicators.ts";
import type {
  SidebarSessionProjection,
  SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import "./menu-surface.ts";
import type {
  SidebarRecentSession,
  SidebarToolActivity,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataOwner } from "./session-data.ts";
import type { SessionOrganizer } from "./session-organizer.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import type { AgentAvatarProps } from "./solid/agent-avatar.tsx";
import type { ChannelAvatarProps } from "./solid/channel-avatar.tsx";
import "./tooltip.ts";

export interface SessionListHost {
  loadMoreSidebarSessions(): Promise<void>;
  readonly presencePeople?: Map<string, HTMLElement>;
  readonly sidebarSnapshot?: import("./sidebar-snapshot-model.ts").SidebarSnapshotModel | null;
  readonly sidebarAgentsMode?: "chip" | "roster";
  readonly basePath: string;
  readonly sessionDataContext:
    | Pick<ApplicationContext, "gateway" | "agentSelection" | "agents" | "sessions">
    | undefined;
  readonly sidebarLiveActivity: boolean;
  readonly sessionsShowCron: boolean;
  readonly sessionsShowPreview: boolean;
  readonly sessionsShowSystem: boolean;
  readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  readonly sidebarTools: ReadonlyMap<string, SidebarToolActivity>;
  readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  readonly sessionProjection: Pick<
    SidebarSessionProjection,
    "resolveSubtitle" | "heldSubtitle" | "mountCatalogRow"
  >;
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly connected: boolean;
  readonly sessionData: Pick<
    SessionDataOwner,
    | "childSessionErrorsByParent"
    | "dismissSessionMutationError"
    | "loadMoreSessionCatalog"
    | "loadMoreSidebarSessions"
    | "presenceInstanceId"
    | "presencePayload"
    | "refreshSessionCatalogs"
    | "retryChildSessions"
    | "sessionCatalogRefreshStatus"
    | "sessionMutationError"
    | "visibleSessionLimits"
  >;
  readonly sessionsGrouping: SidebarSessionsGrouping;
  readonly collapsedSessionSections: ReadonlySet<string>;
  readonly sessionOrganizer: Pick<
    SessionOrganizer,
    | "draggingSidebarSection"
    | "draggingSessionKey"
    | "isDraggingChildSession"
    | "finishSessionDrag"
    | "finishSidebarSectionDrag"
    | "handleSessionListDragLeave"
    | "handleSessionListDragOver"
    | "handleSessionListDrop"
    | "handleSidebarZoneDragLeave"
    | "sidebarZoneDropTarget"
    | "sectionDragLeave"
    | "sectionDragOver"
    | "sectionDrop"
    | "sessionDropTarget"
    | "sidebarSectionDropTarget"
    | "sessionListRemovalDrop"
    | "startSessionDrag"
    | "startSidebarSectionDrag"
    | "archiveSessionWithUndo"
    | "patchSession"
    | "isPersonalSessionPin"
    | "sectionHeaders"
  >;
  readonly sidebarMenus: Pick<
    SidebarMenus,
    | "catalogMenu"
    | "catalogMenuView"
    | "catalogViewMenuPosition"
    | "openCatalogViewMenu"
    | "openSessionGroupMenu"
    | "openSessionMenu"
    | "sessionGroupMenu"
    | "sessionMenu"
    | "sessionSortMenuPosition"
    | "toggleCatalogViewMenu"
    | "togglePositionedMenu"
  >;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionOwnerFilterActive: boolean;
  readonly sessionOwnerFilterId: string | null;
  readonly sessionInvolvingMeFilterActive: boolean;
  readonly sessionOwnerOptions: readonly SessionOwnerOption[];
  readonly sessionOwnershipVisibility: {
    filters: boolean;
    avatars: boolean;
  };
  readonly onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;
  readonly sessionPullRequests: Pick<SessionPullRequestIndicators, "summary" | "count">;
  mainSessionRow(): GatewaySessionRow | null;
  setSessionOwnerFilter(ownerId: string | null, involvingMe?: boolean): void;
  isSessionChildrenExpanded(session: SidebarRecentSession): boolean;
  isSessionChildrenFullyShown(sessionKey: string): boolean;
  sidebarSessionHref(session: SidebarRecentSession): string;
  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession): void;
  toggleSessionChildren(session: SidebarRecentSession): void;
  toggleSessionPin(session: SidebarRecentSession): void;
  toggleSessionMenu(
    session: SidebarRecentSession,
    trigger: HTMLElement,
    catalogMenu?: CatalogSessionMenuRequest,
  ): void;
  showMoreChildren(sessionKey: string): void;
  toggleSection(sectionId: string): void;
  expandedAgentId(): string;
  /** Foreground create display; never roster membership or saved selection. */
  sessionCreateDisplay():
    | Readonly<{
        creation: Readonly<{ sessionKey: string; admitted: boolean }>;
        displayName?: string;
        category?: string;
      }>
    | undefined;
  readNewSessionAccess(): SessionMethodAccess;
  readSessionMutationAccess(request: SessionMethodAccessRequest): SessionMethodAccess;
  requestOpenNewSession(agentId: string, target?: NewSessionTarget): void;
  setVisibleSessionLimit(sectionId: string, limit: number): void;
  resetVisibleSessionLimit(sectionId: string): void;
  clearSessionSelection(): void;
}

export type SessionCatalogRenderSnapshot = {
  catalogs: readonly SidebarSessionCatalog[];
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  mainKey: string;
  loadingMoreCatalogIds: ReadonlySet<string>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  toSidebarSession: (row: GatewaySessionRow) => SidebarRecentSession;
  catalogOpenTarget: CatalogOpenTarget;
  terminalAvailable: boolean;
};
export type SessionCatalogGroupsParams = {
  host: SessionListHost;
  snapshot: SessionCatalogRenderSnapshot;
  catalog: SidebarSessionCatalog;
};

export type RenderableSessionSection = SidebarVisibleSections["sections"][number];
export type SidebarSessionListHost = SessionListHost & {
  readonly sidebarAgentsMode: "chip" | "roster";
  readonly sessionData: SessionListHost["sessionData"] &
    Pick<
      SessionDataOwner,
      | "context"
      | "sessionsLoading"
      | "sessionsStartingUp"
      | "sessionsResult"
      | "sessionCatalogs"
      | "sessionCatalogLive"
      | "loadingMoreSessionCatalogIds"
    >;
  projectHomeSession(row: GatewaySessionRow, agentId: string): SidebarRecentSession;
  resolvePersonalGroupSession?(key: string): SidebarRecentSession | undefined;
  readonly collapsedPersonalSessionGroups: ReadonlySet<string>;
  togglePersonalSessionGroup(id: string): void;
  personalGroupSessionRows(group: PersonalSessionGroup): SidebarRecentSession[];
  reconciledSidebarZone(): {
    entries: readonly SidebarZoneEntry[];
    sessionRows: ReadonlyMap<string, SidebarRecentSession>;
  };
};

export type PersonHeaders = {
  presence: ReadonlyMap<string, PresenceActivity>;
  selfProfileId?: string;
};

type BridgeAttributes<Props> = SolidJSX.HTMLAttributes<SolidBridgeElement<Props>> & {
  [Key in keyof Props as `prop:${Key & string}`]?: Props[Key];
};

// These contracts are UI-local; public SDK declarations must not import renderer modules.
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sidebar-session-filter-popover": HTMLAttributes<HTMLElement>;
      "openclaw-sidebar-collapse-toggle": HTMLAttributes<HTMLElement>;
      "openclaw-agent-avatar": BridgeAttributes<AgentAvatarProps>;
      "openclaw-catalog-session-menu": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-catalog-session-menu"]
      > &
        Properties<HTMLElementTagNameMap["openclaw-catalog-session-menu"]> & {
          "prop:onAction"?: HTMLElementTagNameMap["openclaw-catalog-session-menu"]["onAction"];
          "prop:onClose"?: HTMLElementTagNameMap["openclaw-catalog-session-menu"]["onClose"];
        };
      "openclaw-channel-avatar": BridgeAttributes<ChannelAvatarProps>;
      "openclaw-menu-surface": HTMLAttributes<HTMLElementTagNameMap["openclaw-menu-surface"]> &
        Properties<HTMLElementTagNameMap["openclaw-menu-surface"]>;
      "openclaw-plugin-contributions": HTMLAttributes<ContributionsElement> &
        Properties<ContributionsElement> & {
          "prop:agentId"?: ContributionsElement["agentId"];
          "prop:navigationMenus"?: ContributionsElement["navigationMenus"];
        };
    }
  }
}
