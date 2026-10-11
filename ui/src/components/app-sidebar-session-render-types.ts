import type { JSX as SolidJSX } from "@solidjs/web";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { PresenceActivity } from "../lib/presence-users.ts";
import type {
  SessionMethodAccess,
  SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type {
  ControlUiPluginView,
  ControlUiPluginContributions,
} from "../plugins/control-ui-view.runtime.ts";
import type {
  CatalogBackingSessionDisplay,
  CatalogSessionMenuRequest,
  SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import type {
  SidebarSessionProjection,
  SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import type {
  SidebarRecentSession,
  SidebarToolActivity,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { CatalogSessionMenu } from "./catalog-session-menu.ts";
import "./mcp-app-catalog.tsx";
import "./menu-surface.ts";
import type { RelativeTime } from "./relative-time.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";
import type { AgentAvatarProps } from "./solid/agent-avatar.tsx";
import type { ChannelAvatarProps } from "./solid/channel-avatar.tsx";
import type { SessionOwnerChipProps } from "./solid/session-owner-chip.tsx";
import type { ViewerAvatarProps, ViewerFacepileProps } from "./solid/viewer-facepile.tsx";
import type { ThemeModeToggle } from "./theme-mode-toggle.ts";
import "./tooltip.ts";

export interface SessionListHost {
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
  readonly sessionProjection: Pick<SidebarSessionProjection, "resolveSubtitle">;
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly connected: boolean;
  readonly sessionData: Pick<
    SessionDataController,
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
    SessionOrganizerController,
    | "draggingSidebarSection"
    | "draggingSessionKey"
    | "isDraggingChildSession"
    | "finishSessionDrag"
    | "finishSidebarSectionDrag"
    | "handleSessionListDragLeave"
    | "handleSessionListDragOver"
    | "handleSessionListDrop"
    | "sectionDragLeave"
    | "sectionDragOver"
    | "sectionDrop"
    | "sessionDropTarget"
    | "sidebarSectionDropTarget"
    | "sessionListRemovalDrop"
    | "setSessionsStatusFilter"
    | "startSessionDrag"
    | "startSidebarSectionDrag"
    | "archiveSessionWithUndo"
    | "patchSession"
    | "isPersonalSessionPin"
    | "reorderSidebarSection"
  >;
  readonly sidebarMenus: Pick<
    SidebarMenusController,
    | "catalogMenu"
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
  readonly sessionPullRequests: Pick<SessionPullRequestIndicatorsController, "summary">;
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
  readNewSessionAccess(): SessionMethodAccess;
  readSessionMutationAccess(request: SessionMethodAccessRequest): SessionMethodAccess;
  requestOpenNewSession(agentId: string, target?: NewSessionTarget): void;
  setVisibleSessionLimit(sectionId: string, limit: number): void;
  clearSessionSelection(): void;
}

export type SessionCatalogGroupsParams = {
  catalogs: readonly SidebarSessionCatalog[];
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  mainKey: string;
  collapsedSections: ReadonlySet<string>;
  loadingMoreCatalogIds: ReadonlySet<string>;
  visibleSessionLimits: ReadonlyMap<string, number>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  renderLiveRow: (
    row: () => GatewaySessionRow,
    display: CatalogBackingSessionDisplay,
  ) => SolidJSX.Element;
  onToggleSection: (sectionId: string) => void;
  draggingSectionId: string | null;
  sectionDropTarget: {
    sectionId: string;
    position: "before" | "after";
  } | null;
  onSectionDragOver: (event: DragEvent, sectionId: string) => void;
  onSectionDragLeave: (event: DragEvent, sectionId: string) => void;
  onSectionDrop: (event: DragEvent, sectionId: string) => void;
  onStartSectionDrag: (sectionId: string) => void;
  onFinishSectionDrag: () => void;
  onReorderSection: (source: string, target: string, position: "before" | "after") => Promise<void>;
  viewMenuOpenCatalogId: string | null;
  ownerFilterActive: boolean;
  onOpenViewMenu: (
    catalogId: string,
    trigger: HTMLElement,
    position?: {
      x: number;
      y: number;
    },
  ) => void;
  onLoadMore: (catalogId: string) => void;
  onSetVisibleSessionLimit: (sectionId: string, limit: number) => void;
  onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  newSessionDisabledReason?: string;
  sectionDragDisabledReason?: string;
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  catalogOpenTarget: "viewer" | "terminal";
  terminalAvailable: boolean;
  onOpenTerminal: (key: CatalogSessionKey, agentId: string) => void;
  onOpenMenu: (
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ) => void;
  onCatalogMenuTriggerRendered: (key: CatalogSessionKey, element: Element | undefined) => void;
  isMenuOpen: (key: CatalogSessionKey) => boolean;
};

export type RenderableSessionSection = SidebarVisibleSections["sections"][number];
export type SidebarSessionListHost = SessionListHost & {
  readonly sidebarAgentsMode: "chip" | "roster";
  readonly sessionData: SessionListHost["sessionData"] &
    Pick<
      SessionDataController,
      | "context"
      | "sessionsLoading"
      | "sessionsStartingUp"
      | "sessionsResult"
      | "sessionCatalogs"
      | "sessionCatalogLive"
      | "loadingMoreSessionCatalogIds"
    >;
  projectHomeSession(row: GatewaySessionRow, agentId: string): SidebarRecentSession;
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
      "openclaw-agent-avatar": BridgeAttributes<AgentAvatarProps>;
      "openclaw-catalog-session-menu": HTMLAttributes<CatalogSessionMenu> &
        Properties<CatalogSessionMenu> & {
          "prop:onAction"?: CatalogSessionMenu["onAction"];
          "prop:onClose"?: CatalogSessionMenu["onClose"];
        };
      "openclaw-channel-avatar": BridgeAttributes<ChannelAvatarProps>;
      "openclaw-mcp-app-catalog": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-mcp-app-catalog"]
      > &
        Properties<HTMLElementTagNameMap["openclaw-mcp-app-catalog"]> &
        Partial<Pick<HTMLElementTagNameMap["openclaw-mcp-app-catalog"], "surface">>;
      "openclaw-menu-surface": HTMLAttributes<HTMLElementTagNameMap["openclaw-menu-surface"]> &
        Properties<HTMLElementTagNameMap["openclaw-menu-surface"]>;
      "openclaw-plugin-contributions": HTMLAttributes<ControlUiPluginContributions> &
        Properties<ControlUiPluginContributions> & {
          "prop:agentId"?: ControlUiPluginContributions["agentId"];
          "prop:navigationMenus"?: ControlUiPluginContributions["navigationMenus"];
        };
      "openclaw-plugin-view": HTMLAttributes<ControlUiPluginView> &
        Properties<ControlUiPluginView> & {
          "prop:props"?: ControlUiPluginView["props"];
          "prop:defaultView"?: ControlUiPluginView["defaultView"];
          "prop:mountDefaultView"?: ControlUiPluginView["mountDefaultView"];
          "prop:replacementCompanion"?: ControlUiPluginView["replacementCompanion"];
          "prop:defaultHost"?: ControlUiPluginView["defaultHost"];
        };
      "openclaw-relative-time": HTMLAttributes<RelativeTime> & Properties<RelativeTime>;
      "openclaw-session-owner-chip": BridgeAttributes<SessionOwnerChipProps> &
        Partial<Pick<SessionOwnerChipProps, "size" | "attribution">>;
      "openclaw-theme-mode-toggle": HTMLAttributes<ThemeModeToggle> & Properties<ThemeModeToggle>;
      "openclaw-viewer-avatar": BridgeAttributes<ViewerAvatarProps> &
        Pick<ViewerAvatarProps, "variant">;
      "openclaw-viewer-facepile": BridgeAttributes<ViewerFacepileProps> &
        Pick<ViewerAvatarProps, "variant">;
    }
  }
}
