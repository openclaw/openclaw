import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createRoot, runWithOwner, Show } from "solid-js";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
  WorktreesBranchesResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { isSessionRouteId } from "../app-route-paths.ts";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
} from "../lib/sessions/catalog-key.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import "./mcp-app-catalog.tsx";
import "./sidebar-agent-card.tsx";
import "./sidebar-attention.tsx";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { renderAppSidebarOnline, sidebarOnlineOrder } from "./app-sidebar-online.tsx";
import { hidePersonalSidebarCatalog } from "./app-sidebar-personal-navigation.ts";
import { renderSidebarRail, renderSidebarPages } from "./app-sidebar-rail.tsx";
import "../styles/app-sidebar.css";
import "../styles/sidebar-rail.css";
import type { SessionCatalogGroupsRenderer } from "./app-sidebar-session-catalog-render.tsx";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { renderSessionListToolbar } from "./app-sidebar-session-filter-summary.tsx";
import { renderSessionList as SessionList } from "./app-sidebar-session-list-render.tsx";
import type {
  SidebarNarrationSyncInput,
  SidebarNarration,
} from "./app-sidebar-session-narration.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { renderSessionTree as SessionTree } from "./app-sidebar-session-row-render.tsx";
import {
  loadStoredSidebarCatalogGrouping,
  SIDEBAR_SESSION_PAGE_SIZE,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
  type SidebarToolActivity,
} from "./app-sidebar-session-types.ts";
import { SessionOrganizer } from "./session-organizer.ts";
import { SidebarAgentRoster, renderSidebarPinnedSession } from "./sidebar-agent-roster.tsx";
import type { createSidebarScroll } from "./sidebar-context-controller.ts";
import { createSidebarMenus } from "./sidebar-menus.tsx";
import type { SidebarNavigationCatalog } from "./sidebar-navigation-catalog.ts";
import { createSidebarPeople, SidebarPeoplePreferences } from "./sidebar-people.ts";
import {
  captureSidebarSnapshotModel,
  isSidebarSnapshotSettled,
} from "./sidebar-snapshot-capture.ts";
import type { SidebarSnapshotModel } from "./sidebar-snapshot-model.ts";
import { createSidebarSnapshot } from "./sidebar-snapshot.ts";
import { GatewayStatus } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { PanelRefreshStatus } from "./solid/panel-refresh-status.tsx";
import { SidebarCommunityInvite } from "./solid/sidebar-community-invite.tsx";

export class AppSidebarOwner extends AppSidebarSessionNavigationElement implements SessionListHost {
  readNarration: () => ReturnType<SidebarNarration["read"]> | undefined = () => undefined;
  private readonly emptyNarrationLines = new Map<string, string>();
  private readonly emptyNarrationTools = new Map<string, SidebarToolActivity>();
  private readonly emptyObserverDigests = new Map<string, SessionObserverDigest>();
  override get sidebarNarrationLines() {
    return this.readNarration()?.lines ?? this.emptyNarrationLines;
  }
  override get sidebarTools() {
    return this.readNarration()?.tools ?? this.emptyNarrationTools;
  }
  override get sidebarObserverDigests() {
    return this.readNarration()?.observerDigests ?? this.emptyObserverDigests;
  }

  override readonly sessionOrganizer = new SessionOrganizer(this, () => this.invalidate());
  // Native sidebar custody outlives provider/view roots.
  private readonly menuRoot = runWithOwner(null, () =>
    createRoot((dispose) => ({
      menus: createSidebarMenus({
        host: this,
        element: this.hostElement,
        commit: () => {
          this.invalidate();
          return this.updateComplete;
        },
      }),
      dispose,
    })),
  );
  override readonly sidebarMenus = this.menuRoot.menus;
  readonly disposeMenus = this.menuRoot.dispose;
  readonly people = new SidebarPeoplePreferences(() => this.invalidate());
  peopleView?: ReturnType<typeof createSidebarPeople>;
  // A connected host retains its pending boot read when Solid recreates the view.
  readonly snapshot = createSidebarSnapshot(this);

  restoreSidebarSnapshot(model: SidebarSnapshotModel): void {
    this.sidebarSnapshot = model;
    this.navigationView = model.navigationView;
    this.sessionOrganizer.collapsedSessionSections = new Set(model.collapsedSections);
    const rows = [...model.sessions, ...model.sections.flatMap((section) => section.rows)];
    for (const row of rows) {
      rows.push(...row.children);
    }
    this.sessionProjection.children.restore(rows);
    this.people.sortMode = model.peopleSortMode;
    this.people.statusFilter = model.peopleStatusFilter;
    this.people.presenceFilter = model.peoplePresenceFilter;
    sidebarOnlineOrder(this).restore(model.onlineUsers, new Map(model.onlineCounts));
  }

  releaseSidebarSnapshot(): void {
    const snapshot = this.sidebarSnapshot;
    if (snapshot) {
      this.pinnedSessions.seed(snapshot.pinnedSessions);
    }
    this.sidebarPluginSnapshot =
      snapshot && this.context?.plugins.registryStatus !== "complete"
        ? { entries: snapshot.entries, plugins: snapshot.plugins }
        : null;
    this.sidebarSnapshot = null;
  }

  clearSidebarSnapshot(): void {
    this.sidebarSnapshot = null;
    this.sidebarPluginSnapshot = null;
    this.sessionProjection.children.restore([]);
    sidebarOnlineOrder(this).clear();
    this.people.resetView();
    this.people.set("presenceFilter", "online");
  }

  sidebarSnapshotSettled(): boolean {
    return isSidebarSnapshotSettled(this);
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

  // Token suppression and schema validation stay behind the live-activity boundary.
  narration: SidebarNarration | null = null;
  private narrationLoad: Promise<SidebarNarration> | null = null;
  loadNarration(): SidebarNarration | Promise<SidebarNarration> {
    return (
      this.narration ??
      (this.narrationLoad ??= import("./app-sidebar-session-narration.ts").then(
        (module) => (this.narration = module.createSidebarNarration()),
      ))
    );
  }
  constructor(
    public override navigationCatalog: SidebarNavigationCatalog,
    ...args: ConstructorParameters<typeof AppSidebarSessionNavigationElement>
  ) {
    super(...args);
  }
  get nativeGatewaySnapshot(): NativeGatewaysSnapshot | null {
    // SAFETY: The macOS dashboard injects its encoded gateway snapshot at this key; browsers leave it unset.
    const snapshot = (window as Window & { __OPENCLAW_NATIVE_GATEWAYS__?: NativeGatewaysSnapshot })[
      "__OPENCLAW_NATIVE_GATEWAYS__"
    ];
    return snapshot && Array.isArray(snapshot.gateways) ? snapshot : null;
  }

  // Catalog rows are non-startup content. Load their renderer through the same
  // idle boundary as other sidebar chrome, then repaint when the chunk arrives.
  private catalogRenderer: SessionCatalogGroupsRenderer | null = null;
  readonly catalogRendererImport = createIdleImport(
    () => import("./app-sidebar-session-catalog-render.tsx"),
    (module) => {
      this.catalogRenderer = module.renderSessionCatalogGroups;
      if (this.isConnected) {
        this.invalidate();
      }
    },
  );
  catalogProjectGrouping: CatalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  override dismissTransientMenus(): boolean {
    const hadPersonCard = this.peopleView?.dismiss() ?? false;
    return super.dismissTransientMenus() || hadPersonCard;
  }

  override disconnectedCallback() {
    this.sidebarMenus.disconnect();
    this.sessionData.disconnect();
    this.peopleView?.dismiss();
    this.narration?.disconnect();
    super.disconnectedCallback();
    this.snapshot.disconnect();
  }

  protected override willUpdate() {
    super.willUpdate();
    if (this.context?.plugins.registryStatus === "complete") {
      this.sidebarPluginSnapshot = null;
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

  narrationEnabled(): boolean {
    return (
      this.sidebarLiveActivity &&
      this.sidebarAgentsMode === "chip" &&
      this.navigationVisible &&
      !this.navigationCollapsed &&
      this.navigationView === "sessions" &&
      !this.contextualSidebar
    );
  }

  narrationSyncInput(): SidebarNarrationSyncInput {
    const gateway = this.context?.gateway.snapshot;
    const enabled = this.narrationEnabled();
    return {
      enabled,
      connected: this.connected && gateway?.phase === "connected",
      connectionIdentity: gateway?.client ?? null,
      source: this.context?.sessions ?? null,
      rows: enabled ? this.visibleSessionTreeInOrder() : [],
      openSessionKey: isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "",
      agentId: this.selectedAgentIdForSessions(),
    };
  }

  override connectedCallback() {
    this.sidebarMenus.connect();
    this.sessionData.connect();
    this.snapshot.connect();
    super.connectedCallback();
  }

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
      this.invalidate();
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
    this.invalidate();
  }

  hideSessionCatalog(catalogId: string): void {
    hidePersonalSidebarCatalog(this, catalogId);
  }

  renderPinnedSidebarSession(session: () => SidebarRecentSession): JSX.Element {
    const row = <SessionTree host={this} session={session()} listItem={false} />;
    return (
      <Show when={this.sidebarAgentsMode === "roster"} fallback={row}>
        {renderSidebarPinnedSession(this, session)}
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
        catalog:
          !host().catalogRenderer &&
          (catalogs().length > 0 || host().sessionData.sessionCatalogRefreshStatus.error !== null)
            ? host().catalogRendererImport
            : null,
      }),
      ({ catalog }) => {
        if (catalog) {
          void catalog.load().catch(() => undefined);
        }
      },
    );
    const nativeList = (
      <SessionList
        host={host()}
        empty={visibleSessions().length === 0}
        sections={sections()}
        nativeSessionsHaveMore={host().sessionData.sessionsResult?.hasMore === true}
        nativeSessionsLoading={host().sessionData.sessionsLoading}
        catalogRenderer={host().catalogRenderer}
        catalogs={{
          catalogs: catalogs(),
          basePath: host().basePath,
          routeSessionKey: catalogRouteSessionKey(),
          newSessionAgentId: expandedAgentId(),
          mainKey: host().sessionMainKey(),
          loadingMoreCatalogIds: host().sessionData.loadingMoreSessionCatalogIds,
          projectGrouping: host().catalogProjectGrouping,
          liveRows: host().catalogLiveRows(),
          toSidebarSession: navigationState().toSidebarSession,
          catalogOpenTarget: host().catalogOpenTarget,
          terminalAvailable: host().terminalAvailable,
        }}
      />
    );
    return (
      <Show when={host().sidebarAgentsMode === "roster"} fallback={nativeList}>
        <SidebarAgentRoster
          host={host()}
          active={
            host().navigationVisible &&
            host().navigationView === "sessions" &&
            !host().contextualSidebar
          }
          sections={sections()}
          involvingMe={host().sessionInvolvingMeFilterActive}
        />
      </Show>
    );
  }

  renderSidebar(
    Sessions: () => JSX.Element,
    scroll: ReturnType<typeof createSidebarScroll>,
    snapshot: { pending(): boolean; saved(): boolean },
  ): JSX.Element {
    const SidebarFrame = () => {
      const scrollRef = scroll.createRef();
      const rail = renderSidebarRail(this);
      const pages = renderSidebarPages(this);
      const toolbar = renderSessionListToolbar(this);
      const online = renderAppSidebarOnline(this);
      const menus = this.sidebarMenus.render(this);
      const statusVisible = () =>
        this.gatewayStatus?.kind &&
        (this.gatewayStatus.kind !== "connected" || this.connectionRecovery);
      return (
        <aside
          class="sidebar sidebar--rail"
          data-snapshot-state={this.sidebarSnapshot ? "cached" : "live"}
          data-snapshot-saved={String(snapshot.saved())}
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
            <div class="sidebar-shell__content">
              <div
                ref={scrollRef}
                class={["sidebar-shell__body", `sidebar-shell__body--scroll-${scroll.state()}`]}
                onScroll={scroll.onScroll}
              >
                <Show
                  when={this.navigationView === "pages"}
                  fallback={
                    <Show
                      when={this.navigationView === "online"}
                      fallback={
                        <>
                          {toolbar}
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
              <Show
                when={
                  this.context.theme.branding.communityLinks &&
                  this.context.config.current.communityInvite
                }
              >
                <SidebarCommunityInvite />
              </Show>
            </div>
            <Show when={statusVisible() || this.devGitBranch}>
              <div class="sidebar-shell__footer">
                <Show when={statusVisible()}>
                  <GatewayStatus {...this.gatewayStatus!} row />
                </Show>
                <Show when={this.devGitBranch}>
                  <openclaw-tooltip prop:content={this.devGitBranch ?? undefined}>
                    <div class="sidebar-footer-branch">
                      <span class="sidebar-footer-branch__icon" aria-hidden="true">
                        <Icon name="gitBranch" />
                      </span>
                      <span class="sidebar-footer-branch__name">{this.devGitBranch}</span>
                    </div>
                  </openclaw-tooltip>
                </Show>
              </div>
            </Show>
          </div>
          {menus}
        </aside>
      );
    };
    return (
      <Show when={!snapshot.pending()}>
        <SidebarFrame />
      </Show>
    );
  }
}
