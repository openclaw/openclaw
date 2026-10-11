import { dynamic, type JSX } from "@solidjs/web";
import { createEffect, createMemo, Show } from "solid-js";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
  WorktreesBranchesResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
} from "../lib/sessions/catalog-key.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import "./session-menu.ts";
import "./mcp-app-catalog.tsx";
import "./sidebar-agent-card.tsx";
import "./sidebar-attention.tsx";
import { showToast } from "../lib/toast.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import {
  renderAppSidebarOnline,
  resolveSidebarOnline,
  sidebarOnlineOrder,
} from "./app-sidebar-online.tsx";
import { renderSidebarRail, renderSidebarPages, renderSidebarScope } from "./app-sidebar-rail.tsx";
import { renderAppSidebarBrand } from "./app-sidebar-render.tsx";
import type { SessionCatalogGroupsRenderer } from "./app-sidebar-session-catalog-render.tsx";
import "../styles/app-sidebar.css";
import "../styles/sidebar-rail.css";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { renderSessionList } from "./app-sidebar-session-list-render.tsx";
import type {
  SidebarNarrationSyncInput,
  SidebarSessionNarrationController,
} from "./app-sidebar-session-narration.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { renderSessionTree, visibleSessionChildren } from "./app-sidebar-session-row-render.tsx";
import {
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarCatalogGrouping,
  SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
  SIDEBAR_SESSION_PAGE_SIZE,
  setStoredSessionCatalogHidden,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
  type SidebarToolActivity,
} from "./app-sidebar-session-types.ts";
import {
  COMMUNITY_INVITE_KEY,
  dismissCommunityInvite as persistCommunityInviteDismissal,
  isCommunityInviteEligible,
} from "./community-invite-state.ts";
import { SessionOrganizerController } from "./session-organizer-controller.ts";
import { SidebarContextController } from "./sidebar-context-controller.ts";
import { SidebarMenusController } from "./sidebar-menus-controller.tsx";
import { SidebarPeopleController } from "./sidebar-people-controller.ts";
import { captureSidebarSnapshotModel } from "./sidebar-snapshot-capture.ts";
import { SidebarSnapshotController } from "./sidebar-snapshot-controller.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";
import { Icon } from "./solid/icon.tsx";
import { PanelRefreshStatus } from "./solid/panel-refresh-status.tsx";
import { SidebarCommunityInvite } from "./solid/sidebar-community-invite.tsx";

export class AppSidebarOwner extends AppSidebarSessionNavigationElement implements SessionListHost {
  private teamOnlineExpandedValue = false;
  get teamOnlineExpanded(): boolean {
    return this.teamOnlineExpandedValue;
  }
  set teamOnlineExpanded(value: boolean) {
    if (Object.is(this.teamOnlineExpandedValue, value)) {
      return;
    }
    this.teamOnlineExpandedValue = value;
    this.requestUpdate();
  }
  override sidebarNarrationLines: ReadonlyMap<string, string> = new Map();
  override sidebarTools: ReadonlyMap<string, SidebarToolActivity> = new Map();
  override sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest> = new Map();

  override readonly sessionOrganizer = new SessionOrganizerController(this);
  override readonly sidebarMenus = new SidebarMenusController(this);
  readonly people = new SidebarPeopleController(this);
  private readonly sidebarSnapshotController = new SidebarSnapshotController(this);

  restoreSidebarSnapshot(model: SidebarSnapshotModel): void {
    this.sidebarSnapshot = model;
    this.navigationView = model.navigationView;
    this.navigationScope = model.navigationScope;
    this.sessionOrganizer.collapsedSessionSections = new Set(model.collapsedSections);
    const rows = [...model.sessions, ...model.sections.flatMap((section) => section.rows)];
    for (const row of rows) {
      rows.push(...row.children);
    }
    this.sessionProjection.restoreChildrenDisplay(rows);
    this.people.sortMode = model.peopleSortMode;
    this.people.statusFilter = model.peopleStatusFilter;
    this.teamOnlineExpanded = model.onlineExpanded;
    sidebarOnlineOrder(this).restore(model.onlineUsers, new Map(model.onlineCounts));
    if (model.mode === "roster") {
      void this.rosterRendererImport.load().catch(() => undefined);
    }
  }

  releaseSidebarSnapshot(): void {
    const snapshot = this.sidebarSnapshot;
    this.sidebarPluginSnapshot =
      snapshot && this.context?.plugins.registryStatus !== "complete"
        ? { entries: snapshot.entries, plugins: snapshot.plugins }
        : null;
    this.sidebarSnapshot = null;
  }

  clearSidebarSnapshot(): void {
    this.sidebarSnapshot = null;
    this.sidebarPluginSnapshot = null;
    this.sessionProjection.restoreChildrenDisplay([]);
    sidebarOnlineOrder(this).clear();
    this.people.resetView();
    this.teamOnlineExpanded = false;
  }

  sidebarSnapshotSettled(): boolean {
    const context = this.context;
    if (!this.connected || !context) {
      return false;
    }
    if (context.gateway.snapshot.selfUser?.id && !this.navigationCatalog.scopesReady) {
      return false;
    }
    if (this.navigationView === "pages" && this.navigationCatalog.dashboards?.loading !== false) {
      return false;
    }
    const people = resolveSidebarOnline(this).users;
    if (
      people.some((person) => person.identity?.type === "profile") &&
      this.sessionData.ownerCounts.counts === null &&
      this.sessionData.ownerCounts.error === null
    ) {
      return false;
    }
    if (this.sidebarAgentsMode === "roster") {
      const roster = rosterActivityStore(context).snapshot;
      return (
        Boolean(this.rosterRenderer) &&
        (roster.membershipReady || roster.error !== null) &&
        !roster.loading &&
        roster.involvingMe === this.sidebarSessionOwnerFilter().involvingMe
      );
    }
    return (
      !this.sessionData.sessionsLoading &&
      (Boolean(this.sessionData.sessionMutationError ?? context.sessions.state.error) ||
        (Boolean(this.sessionData.sessionsResult) && !context.sessions.presentation.resultCached))
    );
  }

  captureSidebarSnapshot(): SidebarSnapshotModel | null {
    if (!this.context) {
      return null;
    }
    const rows = this.selectedAgentSessionRows(this.getSessionNavigationState());
    return captureSidebarSnapshotModel(
      this,
      this.context,
      rows,
      this.zonedVisibleSections(rows).sections,
    );
  }

  sessionGroupDefaults(name: string) {
    if (this.context?.sessions.groupsStatus() !== "ready") {
      return null;
    }
    const group = this.context?.sessions.state.groupSettings.find((entry) => entry.name === name);
    return group ? { cwd: group.cwd ?? "", worktree: group.worktree === true } : null;
  }

  async listSessionGroupFolders(path?: string): Promise<FsListDirResult> {
    const sessions = this.context?.sessions;
    const scope = sessions?.captureConnectionScope();
    if (!sessions || !scope) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    const result = await scope.client.request<FsListDirResult>("fs.listDir", path ? { path } : {});
    if (this.context?.sessions !== sessions || !sessions.isConnectionScopeCurrent(scope)) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    return result;
  }

  async inspectSessionGroupRepository(path?: string): Promise<WorktreeRepositoryStatus> {
    const requestedPath = path?.trim() || this.activeChipAgent().agent?.workspace?.trim();
    if (!requestedPath) {
      return "unavailable";
    }
    const sessions = this.context?.sessions;
    const scope = sessions?.captureConnectionScope();
    if (!sessions || !scope) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    const result = await scope.client.request<WorktreesBranchesResult>("worktrees.branches", {
      repoRoot: requestedPath,
      includeRepositoryStatus: true,
    });
    if (this.context?.sessions !== sessions || !sessions.isConnectionScopeCurrent(scope)) {
      throw new Error(t("sessionsView.groupDefaultsStale"));
    }
    return result.repositoryStatus === "git" || result.repositoryStatus === "not_git"
      ? result.repositoryStatus
      : "unavailable";
  }

  // Lazy: the controller pulls core token-suppression modules that must stay
  // out of the startup chunk (QA smoke startup-JS budget). It loads on the
  // first update with the preference enabled; earlier events are safely
  // dropped because the controller aligns from cumulative snapshots.
  private narration: SidebarSessionNarrationController | null = null;
  private narrationLoad: Promise<void> | null = null;
  private readonly sidebarContext = new SidebarContextController(this);
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.sidebarSnapshotController,
      (snapshot) => {
        snapshot.connect();
        return () => snapshot.disconnect();
      },
    )
    .watchStore(() => this.sidebarSnapshotController)
    .effect(
      () => this.context?.gateway,
      (gateway) => gateway.subscribeEvents((event) => this.narration?.handleEvent(event)),
    )
    .watchStore(() => this.context?.agentIdentity)
    .watchStore(
      () => this.context?.theme,
      () => this.syncCommunityInviteState(),
    )
    .watchStore(
      () => this.context?.config,
      () => this.syncCommunityInviteState(),
    )
    .watchStore(() => this.context?.plugins);
  get nativeGatewaySnapshot(): NativeGatewaysSnapshot | null {
    // SAFETY: The macOS dashboard injects its encoded gateway snapshot at this key; browsers leave it unset.
    const snapshot = (window as Window & { __OPENCLAW_NATIVE_GATEWAYS__?: NativeGatewaysSnapshot })[
      "__OPENCLAW_NATIVE_GATEWAYS__"
    ];
    return snapshot && Array.isArray(snapshot.gateways) ? snapshot : null;
  }

  private readonly nativeGatewaysChanged = () => {
    this.sidebarMenus.closeSessionMenu();
    this.requestUpdate();
  };
  private readonly hiddenSessionCatalogsChanged = () => {
    this.hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
    this.requestUpdate();
  };
  private communityInvitePresentation: "unavailable" | "pending" | "shown" = "unavailable";
  private readonly communityInviteStorageChanged = (event: StorageEvent) => {
    if (event.key === COMMUNITY_INVITE_KEY || event.key === null) {
      this.syncCommunityInviteState();
    }
  };

  // Catalog rows are non-startup content. Load their renderer through the same
  // idle boundary as other sidebar chrome, then repaint when the chunk arrives.
  private catalogRenderer: SessionCatalogGroupsRenderer | null = null;
  private readonly catalogRendererImport = createIdleImport(
    () => import("./app-sidebar-session-catalog-render.tsx"),
    (module) => {
      this.catalogRenderer = module.renderSessionCatalogGroups;
      if (this.isConnected) {
        this.requestUpdate();
      }
    },
  );
  private rosterRenderer: typeof import("./sidebar-agent-roster.tsx") | null = null;
  private readonly rosterRendererImport = createIdleImport(
    () => import("./sidebar-agent-roster.tsx"),
    (module) => {
      this.rosterRenderer = module;
      this.requestUpdate();
    },
  );
  catalogProjectGrouping: CatalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  override dismissTransientMenus(): boolean {
    const hadPersonCard = this.people.dismiss();
    return super.dismissTransientMenus() || hadPersonCard;
  }

  override disconnectedCallback() {
    this.rosterRendererImport.dispose();
    window.removeEventListener("openclaw:native-gateways-changed", this.nativeGatewaysChanged);
    window.removeEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    this.narration?.disconnect();
    this.catalogRendererImport.dispose();
    window.removeEventListener("storage", this.communityInviteStorageChanged);
    super.disconnectedCallback();
  }

  protected override willUpdate() {
    super.willUpdate();
    this.sidebarSnapshotController.synchronize();
    if (this.context?.plugins.registryStatus === "complete") {
      this.sidebarPluginSnapshot = null;
    }
    // Admit new geometry only between interactions; once shown it stays put.
    // Popover focus can leave :focus-within false; inspect the owned DOM instead.
    // Native drag can clear :hover, so retain the organizer's authoritative drag facts.
    if (
      this.communityInvitePresentation === "pending" &&
      !this.matches(":hover") &&
      !this.contains(this.ownerDocument.activeElement) &&
      this.sessionOrganizer.draggingSessionKey === null &&
      this.sessionOrganizer.draggingSidebarSection === null &&
      this.sessionOrganizer.draggingSidebarEntry === null
    ) {
      this.communityInvitePresentation = "shown";
    }
    // An open switcher tracks roster/reconnect updates; otherwise only hydrate
    // the active card and avoid background RPCs for every configured agent.
    const identityIds =
      this.sidebarMenus.agentMenuPosition === null
        ? [this.expandedAgentId()]
        : this.activeChipAgent().agents.map((agent) => agent.id);
    this.ensureAgentIdentities(identityIds);
  }

  ensureAgentIdentities(agentIds: readonly string[]): void {
    if (this.connected) {
      void this.context?.agentIdentity.ensure(agentIds);
    }
  }

  override updated() {
    super.updated();
    this.sidebarSnapshotController.capture();
    if (!this.narration) {
      if (this.sidebarLiveActivity) {
        this.ensureNarrationController();
      }
    } else {
      this.narration.sync(this.narrationSyncInput());
    }
  }

  private visibleNarrationRowsInOrder(): SidebarRecentSession[] {
    const rows: SidebarRecentSession[] = [];
    const append = (session: SidebarRecentSession) => {
      rows.push(session);
      if (this.isSessionChildrenExpanded(session)) {
        visibleSessionChildren({
          session,
          fullyShown: this.isSessionChildrenFullyShown(session.key),
        }).forEach(append);
      }
    };
    this.visibleSessionRowsInOrder().forEach(append);
    return rows;
  }

  private narrationSyncInput(): SidebarNarrationSyncInput {
    const gateway = this.context?.gateway.snapshot;
    return {
      enabled: this.sidebarLiveActivity,
      connected: this.connected && gateway?.phase === "connected",
      connectionIdentity: gateway?.client ?? null,
      source: this.context?.sessions ?? null,
      rows: this.visibleNarrationRowsInOrder(),
      openSessionKey: isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "",
      agentId: this.selectedAgentIdForSessions(),
    };
  }

  private ensureNarrationController(): void {
    if (this.narration || this.narrationLoad) {
      return;
    }
    this.narrationLoad = import("./app-sidebar-session-narration.ts").then((module) => {
      this.narrationLoad = null;
      // The element may have left the DOM while the chunk loaded.
      if (!this.isConnected) {
        return;
      }
      this.narration = new module.SidebarSessionNarrationController(
        (lines) => {
          this.sidebarNarrationLines = lines;
          this.requestUpdate();
        },
        (digests) => {
          this.sidebarObserverDigests = digests;
          this.requestUpdate();
        },
        (tools) => {
          this.sidebarTools = tools;
          this.requestUpdate();
        },
      );
      this.narration.sync(this.narrationSyncInput());
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("openclaw:native-gateways-changed", this.nativeGatewaysChanged);
    this.hiddenSessionCatalogsChanged();
    window.addEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    window.addEventListener("storage", this.communityInviteStorageChanged);
    this.syncCommunityInviteState();
    this.catalogRendererImport.schedule();
  }

  private readonly handleSidebarInteractionEnd = (event: Event) => {
    // Internal focus handoffs can briefly clear :focus-within before the new target focuses.
    if (
      this.communityInvitePresentation !== "pending" ||
      (event instanceof FocusEvent &&
        event.relatedTarget instanceof Node &&
        this.contains(event.relatedTarget))
    ) {
      return;
    }
    this.requestUpdate();
  };

  private syncCommunityInviteState() {
    if (
      this.context?.theme.branding.communityLinks === false ||
      this.context?.config.current.communityInvite !== true ||
      !isCommunityInviteEligible()
    ) {
      this.communityInvitePresentation = "unavailable";
    } else if (this.communityInvitePresentation !== "shown") {
      this.communityInvitePresentation = "pending";
    }
  }

  private readonly dismissCommunityInvite = () => {
    const result = persistCommunityInviteDismissal();
    this.syncCommunityInviteState();
    this.requestUpdate();
    if (!result.ok) {
      showToast({ message: t("communityInvite.dismissFailed") });
    }
  };

  toggleSessionPin(session: SidebarRecentSession): void {
    this.sessionOrganizer.setPersonalSessionPin(
      session.key,
      !this.sessionOrganizer.isPersonalSessionPin(session.key),
    );
  }

  toggleSessionMenu(
    session: SidebarRecentSession,
    trigger: HTMLElement,
    catalogMenu?: CatalogSessionMenuRequest,
  ): void {
    if (catalogMenu) {
      if (this.sidebarMenus.catalogMenu.isOpenFor(catalogMenu.key)) {
        this.sidebarMenus.catalogMenu.close();
        return;
      }
      const rect = trigger.getBoundingClientRect();
      this.sidebarMenus.catalogMenu.open(catalogMenu, rect.right, rect.bottom + 4, trigger);
      return;
    }
    if (this.sidebarMenus.sessionMenu?.session.key === session.key) {
      this.sidebarMenus.closeSessionMenu();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    this.sidebarMenus.openSessionMenu(session, rect.right, rect.bottom + 4, trigger);
  }

  toggleSection(sectionId: string): void {
    if (!this.collapsedSessionSections.has(sectionId)) {
      this.sessionProjection.resetMembership(sectionId);
    }
    this.sessionOrganizer.toggleSection(sectionId);
  }

  setVisibleSessionLimit(sectionId: string, limit: number): void {
    const grouped = this.sidebarAgentsMode === "roster" && sectionId.startsWith("agent:");
    const previousLimit =
      (grouped ? this.rosterVisibleSessionLimits : this.sessionData.visibleSessionLimits).get(
        sectionId,
      ) ?? SIDEBAR_SESSION_PAGE_SIZE;
    if (limit < previousLimit) {
      this.sessionProjection.resetMembership(sectionId);
    }
    if (grouped) {
      this.rosterVisibleSessionLimits = new Map(this.rosterVisibleSessionLimits).set(
        sectionId,
        limit,
      );
      this.requestUpdate();
    } else {
      this.sessionData.setVisibleSessionLimit(sectionId, limit);
    }
  }

  preloadCatalogRenderer() {
    return this.catalogRendererImport.load();
  }

  setCatalogProjectGrouping(next: CatalogProjectGrouping): void {
    storeSidebarCatalogGrouping(next);
    this.catalogProjectGrouping = next;
    this.requestUpdate();
  }

  hideSessionCatalog(catalogId: string): void {
    const label =
      this.sessionData.sessionCatalogs.find((catalog) => catalog.id === catalogId)?.label ??
      catalogId;
    setStoredSessionCatalogHidden(catalogId, true);
    // Reuse the settings-search destination for the Sidebar preferences block so the
    // toast opens the same place the rest of the app calls "Appearance > Sidebar".
    const recovery = SETTINGS_ROUTE_TARGETS.appearanceSidebar;
    const recoveryHref =
      pathForRoute(recovery.routeId, this.basePath) + recovery.search + recovery.hash;
    // The section disappears instantly and its only standing recovery lives on another
    // page, so the outcome is announced where the action happened: undo here, plus a
    // link that opens the re-enable block for after the toast is gone. Longer than the
    // 6s default because that text is a recovery instruction, not an acknowledgement.
    const message = this.ownerDocument.createDocumentFragment();
    const recoveryLink = this.ownerDocument.createElement("a");
    recoveryLink.className = "session-link";
    recoveryLink.href = recoveryHref;
    recoveryLink.textContent = t("chat.sidebar.sectionHiddenRecovery");
    recoveryLink.addEventListener("click", (event) => {
      if (!shouldHandleNavigationClick(event)) {
        return;
      }
      event.preventDefault();
      this.onNavigate?.(recovery.routeId, { search: recovery.search, hash: recovery.hash });
    });
    message.append(t("chat.sidebar.sectionHidden", { section: label }), " ", recoveryLink);
    showToast({
      message,
      actionLabel: t("common.undo"),
      onAction: () => setStoredSessionCatalogHidden(catalogId, false),
      durationMs: 12_000,
    });
  }

  renderPinnedSidebarSession(session: () => SidebarRecentSession): JSX.Element {
    const row = renderSessionTree({
      host: this,
      get session() {
        return session();
      },
      listItem: false,
    });
    return (
      <Show
        when={this.sidebarAgentsMode === "roster" ? this.rosterRenderer : null}
        keyed
        fallback={row}
      >
        {(renderer) => renderer.renderSidebarPinnedSession(this, session)}
      </Show>
    );
  }

  renderSessionsBody() {
    const host = () => this;
    const navigationState = createMemo(() => host().getSessionNavigationState());
    const visibleSessions = createMemo(() => host().selectedAgentSessionRows(navigationState()));
    const sections = createMemo(() => host().zonedVisibleSections(visibleSessions()).sections);
    const expandedAgentId = createMemo(() => host().expandedAgentId());
    const catalogs = createMemo(() => host().sidebarSessionCatalogs());
    const catalogRouteSessionKey = createMemo(() => {
      const terminalCatalog =
        host().activeRouteId === "terminal"
          ? catalogSessionKeyFromSearch(
              host().context.router.getState().matches[0]?.location.search ?? "",
            )
          : null;
      return terminalCatalog
        ? buildCatalogSessionKey(terminalCatalog, expandedAgentId())
        : isSessionRouteId(host().activeRouteId)
          ? host().getRouteSessionKey()
          : "";
    });
    createEffect(
      () => ({
        roster: host().sidebarAgentsMode === "roster" && !host().rosterRenderer,
        catalog:
          !host().catalogRenderer &&
          (catalogs().length > 0 || host().sessionData.sessionCatalogRefreshStatus.error !== null),
      }),
      ({ roster, catalog }) => {
        if (roster) {
          void host()
            .rosterRendererImport.load()
            .catch(() => undefined);
        }
        if (catalog) {
          void host()
            .preloadCatalogRenderer()
            .catch(() => undefined);
        }
      },
    );
    const Roster = dynamic(() => host().rosterRenderer?.SidebarAgentRoster);
    const nativeList = renderSessionList({
      host: host(),
      get empty() {
        return visibleSessions().length === 0;
      },
      get sections() {
        return sections();
      },
      get nativeSessionsHaveMore() {
        return host().sessionData.sessionsResult?.hasMore === true;
      },
      get nativeSessionsLoading() {
        return host().sessionData.sessionsLoading;
      },
      get catalogRenderer() {
        return host().catalogRenderer;
      },
      catalogs: {
        get catalogs() {
          return catalogs();
        },
        get basePath() {
          return host().basePath;
        },
        get routeSessionKey() {
          return catalogRouteSessionKey();
        },
        get newSessionAgentId() {
          return expandedAgentId();
        },
        get mainKey() {
          return host().sessionMainKey();
        },
        get loadingMoreCatalogIds() {
          return host().sessionData.loadingMoreSessionCatalogIds;
        },
        get projectGrouping() {
          return host().catalogProjectGrouping;
        },
        get liveRows() {
          return host().catalogLiveRows();
        },
        get toSidebarSession() {
          return navigationState().toSidebarSession;
        },
        get catalogOpenTarget() {
          return host().catalogOpenTarget;
        },
        get terminalAvailable() {
          return host().terminalAvailable;
        },
      },
    });
    return (
      <Show when={host().sidebarAgentsMode === "roster"} fallback={nativeList}>
        <Roster
          host={host()}
          active={host().navigationVisible}
          sections={sections()}
          empty={visibleSessions().length === 0}
          involvingMe={host().sessionInvolvingMeFilterActive}
        />
      </Show>
    );
  }

  renderSidebar(Sessions: () => JSX.Element): JSX.Element {
    const SidebarFrame = () => {
      const NewSessionMenu = dynamic(() => this.rosterRenderer?.SidebarNewSessionMenu);
      const brand = renderAppSidebarBrand(
        this,
        <NewSessionMenu
          host={this}
          active={this.navigationVisible}
          access={this.readNewSessionAccess()}
        />,
      );
      const rail = renderSidebarRail(this);
      const pages = renderSidebarPages(this);
      const scope = renderSidebarScope(this);
      const online = renderAppSidebarOnline(this);
      const menus = this.sidebarMenus.render();
      return (
        <aside
          class="sidebar sidebar--rail"
          data-snapshot-state={this.sidebarSnapshot ? "cached" : "live"}
          data-snapshot-saved={String(this.sidebarSnapshotController.saved)}
          onPointerLeave={this.handleSidebarInteractionEnd}
          onFocusOut={this.handleSidebarInteractionEnd}
          onContextMenu={(event) => {
            if (
              !(event.target instanceof Element) ||
              !event.target.closest("input, textarea, [contenteditable]")
            ) {
              event.preventDefault();
            }
          }}
        >
          {rail}
          <div class="sidebar-shell" onMouseDown={beginNativeWindowDragFromTopInset}>
            {brand}
            <div class="sidebar-shell__content">
              <div
                class={`sidebar-shell__body sidebar-shell__body--scroll-${this.sessionData.sessionsScrollState}`}
                onScroll={(event) => this.sidebarContext.handleScroll(event)}
              >
                <Show
                  when={this.navigationView === "pages"}
                  fallback={
                    <Show
                      when={this.navigationView === "online"}
                      fallback={
                        <>
                          {scope}
                          <div
                            class="sidebar-session-content"
                            hidden={Boolean(this.contextualSidebar)}
                          >
                            <Sessions />
                          </div>
                          {this.contextualSidebar?.render(
                            this.contextualSidebar.data,
                            this.contextualSidebar.loaderPending,
                            true,
                          )}
                        </>
                      }
                    >
                      {online}
                    </Show>
                  }
                >
                  {pages}
                </Show>
              </div>
              <Show when={!this.contextualSidebar && this.sessionsStatusFilter !== "archived"}>
                <PanelRefreshStatus
                  status={this.sessionData.sessionCatalogRefreshStatus}
                  {...{ className: "sidebar-session-error sidebar-session-catalog-error" }}
                />
              </Show>
            </div>
            <div class="sidebar-shell__invite">
              <Show when={this.communityInvitePresentation === "shown"}>
                <SidebarCommunityInvite
                  onDismiss={this.dismissCommunityInvite}
                  mode={this.context.theme.resolvedMode}
                />
              </Show>
            </div>
            <div class="sidebar-shell__footer">
              <Show when={this.devGitBranch}>
                <openclaw-tooltip prop:content={this.devGitBranch}>
                  <div class="sidebar-footer-branch">
                    <span class="sidebar-footer-branch__icon" aria-hidden="true">
                      <Icon name="gitBranch" />
                    </span>
                    <span class="sidebar-footer-branch__name">{this.devGitBranch}</span>
                  </div>
                </openclaw-tooltip>
              </Show>
            </div>
          </div>
          {menus}
        </aside>
      );
    };
    return (
      <Show
        when={
          !this.sidebarSnapshotController.pending &&
          !(this.sidebarSnapshot?.mode === "roster" && !this.rosterRenderer)
        }
      >
        <SidebarFrame />
      </Show>
    );
  }
}
