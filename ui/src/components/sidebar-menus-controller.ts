import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { keyed } from "lit/directives/keyed.js";
import {
  cancelRoutePreload,
  DEFAULT_SIDEBAR_ENTRIES,
  scheduleRoutePreload,
  serializeSidebarEntry,
  type NavigationRouteId,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import type { ThemeMode } from "../app/theme.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { openEditor } from "../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import {
  canArchiveSessionRow,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { renderSidebarAgentMenu, renderSidebarIdentityMenu } from "./app-sidebar-agent-menu.ts";
import { SidebarCatalogMenuController } from "./app-sidebar-catalog-menu.ts";
import {
  isSidebarRouteActive,
  renderSidebarCustomizeMenu,
  renderSidebarMoreMenu,
  renderSidebarNavRoute,
} from "./app-sidebar-nav-menus.ts";
import {
  renderSidebarSessionGroupMenu,
  renderSidebarSessionSortMenu,
} from "./app-sidebar-session-menu-renderers.ts";
import type {
  SidebarRecentSession,
  SidebarSessionGroupMenuState,
  SidebarSessionMenuState,
  SidebarSessionSortMode,
} from "./app-sidebar-session-types.ts";
import type { SidebarWorkboardBoard, SidebarWorkboardRenderers } from "./app-sidebar-workboard.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import { fetchSessionMenuWork } from "./session-menu-work.ts";
import type { SessionMenuAction, SessionMenuWork } from "./session-menu.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOrganizerControllerHost } from "./session-organizer-operations.runtime.ts";

type SidebarMenuAgent = {
  id: string;
  name?: string;
  identity?: { name?: string; emoji?: string; avatar?: string; avatarUrl?: string };
};

interface SidebarMenusControllerState {
  customizeMenuPosition: { x: number; y: number } | null;
  moreMenuPosition: { x: number; y: number } | null;
  sessionMenu: SidebarSessionMenuState | null;
  sessionMenuWork: SessionMenuWork | null;
  sessionGroupMenu: SidebarSessionGroupMenuState | null;
  sessionSortMenuPosition: { x: number; y: number } | null;
  agentMenuPosition: { x: number; bottom: number } | null;
  agentMenuFilter: string;
  identityMenuPosition: { x: number; bottom: number } | null;
}

interface SidebarMenusControllerHost
  extends ReactiveControllerHost, SessionOrganizerControllerHost {
  readonly activeRouteId?: NavigationRouteId;
  readonly activeWorkboardBoardId: string;
  readonly basePath: string;
  readonly canPairDevice: boolean;
  readonly connected: boolean;
  readonly enabledRouteIds?: readonly NavigationRouteId[];
  readonly gatewayVersion: string | null;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;
  readonly onPairMobile?: () => void;
  readonly onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;
  readonly pinnedAgentIds: readonly string[];
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly sessionData: SessionOrganizerControllerHost["sessionData"] &
    Pick<SessionDataController, "approvalBadgeSnapshot" | "sessionsLoading">;
  readonly sessionDataContext: ApplicationContext<RouteId> | undefined;
  readonly sessionOrganizer: SessionOrganizerController;
  readonly sidebarEntries: readonly string[];
  sessionSortMode: SidebarSessionSortMode;
  readonly terminalAvailable: boolean;
  readonly themeMode: ThemeMode;
  readonly workboardBoards: readonly SidebarWorkboardBoard[];
  readonly workboardRenderers?: SidebarWorkboardRenderers;
  activeChipAgent(): {
    activeId: string;
    agent: SidebarMenuAgent | undefined;
    agents: readonly SidebarMenuAgent[];
  };
  agentUnreadCount(agentId: string): number;
  askAgentCapabilities(agentId: string): void;
  getRouteSessionKey(): string;
  getSessionNavigationState(): { selectedAgentId: string };
  reconciledSidebarZone(): {
    entries: readonly SidebarZoneEntry[];
    sidebarEntries: readonly string[];
  };
  selectedVisibleSessions(): SidebarRecentSession[];
  switchChipAgent(agentId: string): void;
}

/** Popup ownership and stateless menu-renderer wiring. */
export class SidebarMenusController implements ReactiveController, SidebarMenusControllerState {
  customizeMenuPosition: { x: number; y: number } | null = null;
  moreMenuPosition: { x: number; y: number } | null = null;
  sessionMenu: SidebarSessionMenuState | null = null;
  sessionMenuWork: SessionMenuWork | null = null;
  sessionGroupMenu: SidebarSessionGroupMenuState | null = null;
  sessionSortMenuPosition: { x: number; y: number } | null = null;
  agentMenuPosition: { x: number; bottom: number } | null = null;
  agentMenuFilter = "";
  // Anchored by its bottom edge so the footer menu grows upward regardless of height.
  identityMenuPosition: { x: number; bottom: number } | null = null;

  private customizeMenuTrigger: HTMLElement | null = null;
  private moreMenuTrigger: HTMLElement | null = null;
  private sessionMenuTrigger: HTMLElement | null = null;
  private sessionMenuWorkVersion = 0;
  private sessionGroupMenuTrigger: HTMLElement | null = null;
  private sessionSortMenuTrigger: HTMLElement | null = null;
  private agentMenuTrigger: HTMLElement | null = null;
  private identityMenuTrigger: HTMLElement | null = null;
  private readonly routePreloadTimers = new Map<
    EventTarget,
    ReturnType<typeof globalThis.setTimeout>
  >();
  readonly catalogMenu: SidebarCatalogMenuController;

  constructor(private readonly host: SidebarMenusControllerHost) {
    host.addController(this);
    this.catalogMenu = new SidebarCatalogMenuController({
      // Closing every transient menu keeps one popover at a time.
      beforeOpen: () => void this.dismissTransientMenus(),
      requestUpdate: () => host.requestUpdate(),
      terminalAvailable: () => host.terminalAvailable,
      navigate: (search) => host.onNavigate?.("chat", { search }),
    });
  }

  hostConnected(): void {}

  hostDisconnected(): void {
    for (const timer of this.routePreloadTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    this.routePreloadTimers.clear();
  }

  private updateState<Key extends keyof SidebarMenusControllerState>(
    key: Key,
    value: SidebarMenusControllerState[Key],
  ): void {
    Object.assign(this, { [key]: value });
    this.host.requestUpdate();
  }

  // The shell calls this before CSS hides the panel or drawer. Mounted menus
  // keep document-level shortcuts alive even when an ancestor is hidden.
  dismissTransientMenus(): boolean {
    const hadTransientMenu = Boolean(
      this.customizeMenuPosition ||
      this.moreMenuPosition ||
      this.sessionMenu ||
      this.catalogMenu.isOpen ||
      this.sessionGroupMenu ||
      this.sessionSortMenuPosition ||
      this.agentMenuPosition ||
      this.identityMenuPosition,
    );
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.catalogMenu.close();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeAgentMenu();
    this.closeIdentityMenu();
    return hadTransientMenu;
  }

  private preloadRoute(routeId: NavigationRouteId, event: Event, immediate = false) {
    scheduleRoutePreload(
      this.routePreloadTimers,
      routeId,
      event,
      (nextRouteId) => this.host.onPreloadRoute?.(nextRouteId),
      routeId === this.host.activeRouteId || !this.isRouteEnabled(routeId),
      immediate,
    );
  }

  private readonly cancelPreload = (event: Event) => {
    cancelRoutePreload(this.routePreloadTimers, event);
  };

  isRouteEnabled(routeId: NavigationRouteId): boolean {
    return this.host.enabledRouteIds?.includes(routeId) ?? true;
  }

  readonly openCustomizeMenuFromContext = (event: MouseEvent) => {
    event.preventDefault();
    this.openCustomizeMenu(event.clientX, event.clientY);
  };

  private openCustomizeMenu(x: number, y: number, trigger: HTMLElement | null = null) {
    const menuWidth = 240;
    const menuMaxHeight = 420;
    this.dismissTransientMenus();
    this.customizeMenuTrigger = trigger;
    this.updateState("customizeMenuPosition", {
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  private closeCustomizeMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.customizeMenuTrigger;
    this.customizeMenuTrigger = null;
    this.updateState("customizeMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleMoreMenu(trigger: HTMLElement) {
    if (this.moreMenuPosition) {
      this.closeMoreMenu();
      return;
    }
    const menuWidth = 240;
    const menuMaxHeight = 420;
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.moreMenuTrigger = trigger;
    this.updateState("moreMenuPosition", {
      x: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  private closeMoreMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.moreMenuTrigger;
    this.moreMenuTrigger = null;
    this.updateState("moreMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  /** A row outside the current selection retargets before the menu opens. */
  openSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    if (!this.host.selectedSessionKeys.has(session.key)) {
      this.host.clearSessionSelection();
    }
    this.showSessionMenu(session, x, y, trigger);
  }

  private showSessionMenu(
    session: SidebarRecentSession,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ) {
    this.dismissTransientMenus();
    this.sessionMenuTrigger = trigger;
    this.updateState("sessionMenu", { session, x, y });
    this.loadSessionMenuWork(session);
  }

  closeSessionMenu() {
    this.sessionMenuTrigger = null;
    this.sessionMenuWorkVersion += 1;
    this.updateState("sessionMenu", null);
    this.updateState("sessionMenuWork", null);
  }

  private loadSessionMenuWork(session: SidebarRecentSession) {
    const version = ++this.sessionMenuWorkVersion;
    if (!session.worktreeId) {
      this.updateState("sessionMenuWork", null);
      return;
    }
    this.updateState("sessionMenuWork", {
      loading: true,
      pullRequestUrl: null,
      worktreePath: null,
    });
    const context = this.host.sessionDataContext;
    const client = context?.gateway.snapshot.client;
    if (!context || !client) {
      this.updateState("sessionMenuWork", {
        loading: false,
        pullRequestUrl: null,
        worktreePath: null,
      });
      return;
    }
    const { selectedAgentId } = this.host.getSessionNavigationState();
    void fetchSessionMenuWork({
      client,
      pullRequestsAvailable:
        isGatewayMethodAdvertised(context.gateway.snapshot, "controlUi.sessionPullRequests") ===
        true,
      sessionKey: session.key,
      agentId: parseAgentSessionKey(session.key)?.agentId ?? selectedAgentId,
      worktreeId: session.worktreeId,
    }).then((work) => {
      if (version === this.sessionMenuWorkVersion) {
        this.updateState("sessionMenuWork", { loading: false, ...work });
      }
    });
  }

  openSessionGroupMenu(group: string, x: number, y: number, trigger: HTMLElement | null) {
    const menuWidth = 224;
    const menuMaxHeight = 160;
    this.dismissTransientMenus();
    this.sessionGroupMenuTrigger = trigger;
    this.updateState("sessionGroupMenu", {
      group,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  private closeSessionGroupMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionGroupMenuTrigger;
    this.sessionGroupMenuTrigger = null;
    this.updateState("sessionGroupMenu", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleSessionSortMenu(trigger: HTMLElement) {
    if (this.sessionSortMenuPosition) {
      this.closeSessionSortMenu();
      return;
    }
    const menuWidth = 200;
    const menuMaxHeight = 280;
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.sessionSortMenuTrigger = trigger;
    this.updateState("sessionSortMenuPosition", {
      x: Math.max(8, Math.min(rect.right, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuMaxHeight - 8)),
    });
  }

  private closeSessionSortMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.sessionSortMenuTrigger;
    this.sessionSortMenuTrigger = null;
    this.updateState("sessionSortMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleAgentMenu(trigger: HTMLElement) {
    if (this.agentMenuPosition) {
      this.closeAgentMenu();
      return;
    }
    const menuWidth = 240;
    const rect = trigger.getBoundingClientRect();
    this.closeCustomizeMenu();
    this.closeMoreMenu();
    this.closeSessionMenu();
    this.closeSessionGroupMenu();
    this.closeSessionSortMenu();
    this.closeIdentityMenu();
    this.agentMenuTrigger = trigger;
    this.updateState("agentMenuFilter", "");
    this.updateState("agentMenuPosition", {
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    });
  }

  closeAgentMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.agentMenuTrigger;
    this.agentMenuTrigger = null;
    this.updateState("agentMenuPosition", null);
    this.updateState("agentMenuFilter", "");
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  toggleIdentityMenu(trigger: HTMLElement) {
    if (this.identityMenuPosition) {
      this.closeIdentityMenu();
      return;
    }
    const menuWidth = 240;
    const rect = trigger.getBoundingClientRect();
    this.dismissTransientMenus();
    this.identityMenuTrigger = trigger;
    this.updateState("identityMenuPosition", {
      x: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 4),
    });
  }

  closeIdentityMenu(options: { restoreFocus?: boolean } = {}) {
    const trigger = this.identityMenuTrigger;
    this.identityMenuTrigger = null;
    this.updateState("identityMenuPosition", null);
    if (options.restoreFocus) {
      trigger?.focus();
    }
  }

  renderCustomizeMenu() {
    const position = this.customizeMenuPosition;
    const trigger = this.customizeMenuTrigger;
    return renderSidebarCustomizeMenu({
      position,
      sidebarEntries: this.host.sidebarEntries,
      isRouteEnabled: (routeId) => this.isRouteEnabled(routeId),
      workboardBoards: this.host.workboardBoards,
      workboardRenderers: this.host.workboardRenderers,
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.customizeMenuPosition !== position) {
          return;
        }
        this.closeCustomizeMenu({ restoreFocus });
      },
      onToggleRoute: (routeId) => {
        const entry = serializeSidebarEntry({ type: "route", route: routeId });
        const canonical = this.host.reconciledSidebarZone().sidebarEntries;
        const next = canonical.includes(entry)
          ? canonical.filter((candidate) => candidate !== entry)
          : [...canonical, entry];
        this.host.onUpdateSidebarEntries?.(next);
      },
      onToggleWorkboardBoard: (boardId) => {
        const entry = serializeSidebarEntry({ type: "workboard", boardId });
        const canonical = this.host.reconciledSidebarZone().sidebarEntries;
        const next = canonical.includes(entry)
          ? canonical.filter((candidate) => candidate !== entry)
          : [...canonical, entry];
        this.host.onUpdateSidebarEntries?.(next);
      },
      onReset: () => {
        // Canonical list, not the render list: unknown-state session slots
        // (other agents, still-loading caches) must survive a route reset.
        const sessions = this.host
          .reconciledSidebarZone()
          .sidebarEntries.filter((entry) => entry.startsWith("session:"));
        this.host.onUpdateSidebarEntries?.([...DEFAULT_SIDEBAR_ENTRIES, ...sessions]);
        this.closeCustomizeMenu({ restoreFocus: true });
      },
    });
  }

  renderAgentMenu() {
    const position = this.agentMenuPosition;
    const trigger = this.agentMenuTrigger;
    const { activeId, agent, agents } = this.host.activeChipAgent();
    return renderSidebarAgentMenu({
      position,
      activeId,
      activeName: agent ? normalizeAgentLabel(agent) : activeId,
      agents,
      filter: this.agentMenuFilter,
      pinnedAgentIds: this.host.pinnedAgentIds,
      connected: this.host.connected,
      agentUnreadCount: (agentId) => this.host.agentUnreadCount(agentId),
      agentApprovalCount: (agentId) =>
        this.host.sessionData.approvalBadgeSnapshot().agentCounts.get(normalizeAgentId(agentId)) ??
        0,
      onFilterChange: (next) => {
        this.updateState("agentMenuFilter", next);
      },
      onSwitchAgent: (agentId) => this.host.switchChipAgent(agentId),
      onAskCapabilities: (agentId) => this.host.askAgentCapabilities(agentId),
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.agentMenuPosition !== position) {
          return;
        }
        this.closeAgentMenu({ restoreFocus });
      },
      onNavigate: (routeId, options) => this.host.onNavigate?.(routeId, options),
    });
  }

  renderIdentityMenu() {
    const position = this.identityMenuPosition;
    const trigger = this.identityMenuTrigger;
    return renderSidebarIdentityMenu({
      position,
      canPairDevice: this.host.canPairDevice,
      basePath: this.host.basePath,
      gatewayVersion: this.host.gatewayVersion,
      themeMode: this.host.themeMode,
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.identityMenuPosition !== position) {
          return;
        }
        this.closeIdentityMenu({ restoreFocus });
      },
      onNavigate: (routeId, options) => this.host.onNavigate?.(routeId, options),
      onPairMobile: () => this.host.onPairMobile?.(),
    });
  }

  renderSessionMenu() {
    const menu = this.sessionMenu;
    if (!menu) {
      return nothing;
    }
    const context = this.host.sessionDataContext;
    const { session } = menu;
    const mainKey = resolveUiConfiguredMainKey({
      agentsList: this.host.sessionDataContext?.agents.state.agentsList,
      hello: this.host.sessionDataContext?.gateway.snapshot.hello,
    });
    const selection = this.host.selectedVisibleSessions();
    const batchRows =
      selection.length > 1 && selection.some((row) => row.key === session.key) ? selection : null;
    const rows = batchRows ?? [session];
    const archiveAllowed = rows.every((row) => canArchiveSessionRow(row, mainKey));
    const allUnread = rows.every((row) => row.unread);
    const allArchived = rows.every((row) => row.archived === true);
    const sharedCategory = rows.every(
      (row) => (row.category ?? null) === (rows[0]?.category ?? null),
    )
      ? (rows[0]?.category ?? null)
      : null;
    return keyed(
      menu,
      html`
        <openclaw-session-menu
          .session=${{
            label: session.label,
            icon: session.icon,
            pinned: session.pinned,
            unread: batchRows ? allUnread : session.unread,
            archived: allArchived,
            category: batchRows ? sharedCategory : (session.category ?? null),
          }}
          .selectionCount=${rows.length}
          .lastActive=${batchRows ? "" : session.meta}
          .anchor=${menu}
          .trigger=${this.sessionMenuTrigger}
          .disabled=${!this.host.connected}
          .forkDisabled=${this.host.sessionData.sessionsLoading || session.modelSelectionLocked}
          .archiveAllowed=${archiveAllowed}
          .cloudWorkerStopAllowed=${Boolean(
            !batchRows &&
            session.cloudWorkerActive &&
            !session.hasActiveRun &&
            context &&
            isGatewayMethodAdvertised(context.gateway.snapshot, "sessions.reclaim") === true,
          )}
          .groups=${this.host.knownSessionGroups()}
          .canOpenChat=${true}
          .work=${batchRows ? null : this.sessionMenuWork}
          .workboard=${null}
          .onClose=${() => {
            if (this.sessionMenu === menu) {
              this.closeSessionMenu();
            }
          }}
          .onAction=${(action: SessionMenuAction) => {
            if (batchRows) {
              void this.host.sessionOrganizer.runBatchSessionAction(action, batchRows, allUnread);
              return;
            }
            switch (action.kind) {
              case "open-chat":
                this.host.selectSession(session.key);
                break;
              case "open-pr":
                openExternalUrlSafe(action.url);
                break;
              case "open-in":
                openEditor(action.editor, action.path);
                break;
              case "toggle-pin":
                void this.host.sessionOrganizer.patchSession(session, { pinned: !session.pinned });
                break;
              case "set-icon":
                void this.host.sessionOrganizer.patchSession(session, { icon: action.icon });
                break;
              case "toggle-unread":
                void this.host.sessionOrganizer.patchSession(session, { unread: !session.unread });
                break;
              case "rename":
                void this.host.sessionOrganizer.renameSession(session);
                break;
              case "fork":
                void this.host.sessionOrganizer.forkSession(session);
                break;
              case "workboard":
                break;
              case "move-to-group":
                if (action.category === null || session.category !== action.category) {
                  void this.host.sessionOrganizer.assignSessionCategory(session, action.category);
                }
                break;
              case "new-group":
                void this.host.sessionOrganizer.createSessionGroup([session]);
                break;
              case "toggle-archived":
                if (session.archived) {
                  void this.host.sessionOrganizer.patchSession(session, { archived: false });
                } else {
                  void this.host.sessionOrganizer.archiveSessionWithUndo(session);
                }
                break;
              case "stop-cloud-worker":
                void this.host.sessionOrganizer.stopCloudWorker(session);
                break;
              case "delete":
                void this.host.sessionOrganizer.deleteSession(session);
                break;
            }
          }}
        ></openclaw-session-menu>
      `,
    );
  }

  renderSessionGroupMenu() {
    const menu = this.sessionGroupMenu;
    return renderSidebarSessionGroupMenu({
      menu,
      trigger: this.sessionGroupMenuTrigger,
      connected: this.host.connected,
      onAction: (action, group) => {
        this.closeSessionGroupMenu({ restoreFocus: true });
        switch (action) {
          case "rename-group":
            void this.host.sessionOrganizer.renameSessionGroupFromMenu(group);
            break;
          case "new-group":
            void this.host.sessionOrganizer.createSessionGroup();
            break;
          case "delete-group":
            void this.host.sessionOrganizer.deleteSessionGroupFromMenu(group);
            break;
        }
      },
      onClose: (restoreFocus) => {
        if (this.sessionGroupMenu !== menu) {
          return;
        }
        this.closeSessionGroupMenu({ restoreFocus });
      },
    });
  }

  renderSessionSortMenu() {
    const position = this.sessionSortMenuPosition;
    return renderSidebarSessionSortMenu({
      position,
      trigger: this.sessionSortMenuTrigger,
      grouping: this.host.sessionsGrouping,
      sortMode: this.host.sessionSortMode,
      statusFilter: this.host.sessionsStatusFilter,
      showCron: this.host.sessionsShowCron,
      onGroupingChange: (grouping) => {
        this.host.sessionOrganizer.setSessionsGrouping(grouping);
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onSortModeChange: (mode) => {
        this.host.sessionSortMode = mode;
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onStatusFilterChange: (statusFilter) => {
        this.host.sessionOrganizer.setSessionsStatusFilter(statusFilter);
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onShowCronChange: (show) => {
        this.host.sessionOrganizer.setSessionsShowCron(show);
        this.closeSessionSortMenu({ restoreFocus: true });
      },
      onClose: (restoreFocus) => {
        if (this.sessionSortMenuPosition !== position) {
          return;
        }
        this.closeSessionSortMenu({ restoreFocus });
      },
    });
  }

  renderRoute(routeId: NavigationRouteId) {
    if (!this.isRouteEnabled(routeId)) {
      return nothing;
    }
    const routeSessionKey = routeId === "chat" ? this.host.getRouteSessionKey() : "";
    const chatSearch =
      routeId === "chat" && routeSessionKey ? searchForSession(routeSessionKey) : "";
    return renderSidebarNavRoute({
      routeId,
      href: chatSearch
        ? `${pathForRoute("chat", this.host.basePath)}${chatSearch}`
        : pathForRoute(routeId, this.host.basePath),
      active:
        isSidebarRouteActive(this.host.activeRouteId, routeId) &&
        !(routeId === "workboard" && this.activeWorkboardBoardIsPinned()),
      onNavigate: () => {
        this.host.onNavigate?.(routeId, chatSearch ? { search: chatSearch } : undefined);
      },
      onPreload: (event, immediate) => this.preloadRoute(routeId, event, immediate),
      onCancelPreload: this.cancelPreload,
    });
  }

  renderMoreMenu() {
    const position = this.moreMenuPosition;
    const trigger = this.moreMenuTrigger;
    return renderSidebarMoreMenu({
      position,
      basePath: this.host.basePath,
      activeRouteId: this.host.activeRouteId,
      activeWorkboardBoardId: this.activeWorkboardBoardIsPinned()
        ? this.host.activeWorkboardBoardId
        : "",
      sidebarEntries: this.host.sidebarEntries,
      isRouteEnabled: (routeId) => this.isRouteEnabled(routeId),
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (this.moreMenuPosition !== position) {
          return;
        }
        this.closeMoreMenu({ restoreFocus });
      },
      onNavigateRoute: (routeId) => {
        this.closeMoreMenu({ restoreFocus: true });
        this.host.onNavigate?.(routeId);
      },
      onPreloadRoute: (routeId, event) => this.preloadRoute(routeId, event),
      onCancelPreload: this.cancelPreload,
      onEditPinnedItems: () => {
        const customizePosition = this.moreMenuPosition;
        const customizeTrigger = this.moreMenuTrigger;
        if (customizePosition) {
          this.openCustomizeMenu(customizePosition.x, customizePosition.y, customizeTrigger);
        }
      },
    });
  }

  private activeWorkboardBoardIsPinned(): boolean {
    return Boolean(
      this.host.activeWorkboardBoardId &&
      this.host
        .reconciledSidebarZone()
        .entries.some(
          (entry) =>
            entry.type === "workboard" && entry.boardId === this.host.activeWorkboardBoardId,
        ),
    );
  }
}
