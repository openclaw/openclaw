import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { runSessionNavigationIntent } from "../lib/sessions/navigation-handoff.ts";
import {
  composerDraftSearch,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  normalizeAgentId,
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../lib/sessions/session-key.ts";
import {
  projectSidebarAgentSessionRows,
  projectSidebarHomeSession,
} from "./app-sidebar-agent-session-rows.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import { scheduleSidebarChildSessions } from "./app-sidebar-child-session-data.ts";
import { excludeSessionCatalogRows } from "./app-sidebar-session-catalog-state.ts";
import {
  adoptedCatalogSessionKeys,
  projectSidebarSessionCatalogs,
  visibleSessionCatalogProjection,
} from "./app-sidebar-session-catalogs.ts";
import {
  findActiveSidebarLineageRow,
  findSidebarHovercardRow,
  mergeAdoptedSessionPullRequestRows,
} from "./app-sidebar-session-lookup.ts";
import {
  buildReconciledSidebarZone,
  buildSidebarSessionNavigationState,
  createSidebarSessionRowsComparator,
  collectKnownSidebarSessionCatalogIds,
  collectKnownSidebarSessionGroups,
  extendSidebarSessionSelection,
  findSidebarMainSessionRow,
  findProjectedSidebarSession,
  resolveActiveSidebarAgent,
  resolveSidebarHomeAttention,
  resolveLatestSidebarAgentSession,
  resolveSidebarAgentResumeKey,
  resolveSidebarMainSessionKey,
  toggleSidebarSessionSelection,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import { applySidebarSessionOwnerFilter } from "./app-sidebar-session-ownership.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import {
  SidebarSessionProjection,
  type SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionsGrouping,
  loadStoredSidebarSessionsShowCron,
  loadStoredSidebarSessionsShowPreview,
  loadStoredSidebarSessionsShowSystem,
  resolveSidebarSessionSortMode,
  storeSidebarSessionSortMode,
  type SidebarEmptyGroupsMode,
  type SidebarRecentSession,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { SessionAttentionController } from "./session-attention-controller.ts";
import { SessionDataController } from "./session-data-controller.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";
import { SidebarEmptyGroupsController } from "./sidebar-empty-groups-controller.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

/** Session-row projection, selection, sorting, and agent scope navigation. */
export class AppSidebarSessionNavigationElement extends AppSidebarBase {
  @state() rosterSessionSource: {
    result: SessionsListResult | null;
    agentIds: readonly string[];
    collapsedAgentIds: ReadonlySet<string>;
  } | null = null;

  protected readonly rosterVisibleSessionLimits = new Map<string, number>();

  private get groupedSessionSource() {
    return this.sidebarAgentsMode === "roster" ? this.rosterSessionSource : null;
  }

  @state() sessionSortMode: SidebarSessionSortMode = loadStoredSidebarSessionSortMode();

  readonly sessionProjection = new SidebarSessionProjection();
  readonly sessionData = new SessionDataController(this);
  readonly sessionPullRequests = new SessionPullRequestIndicatorsController(this, {
    getConnected: () => this.connected,
    getRows: () =>
      mergeAdoptedSessionPullRequestRows({
        rows: this.visibleSessionRowsInOrder(),
        adopted: adoptedCatalogSessionKeys(this.visibleSessionCatalogs()),
        sessionsResult: this.groupedSessionSource?.result ?? this.sessionData.sessionsResult,
        sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
        navigationState: this.getSessionNavigationState(),
      }),
    getSelectedAgentId: () => this.selectedAgentIdForSessions(),
    getGateway: () => this.context?.gateway,
    getSessions: () => this.context?.sessions,
  });

  private readonly readSidebarSessionSortOptions = () => ({
    sortMode: this.effectiveSessionSortMode(),
    owners: this.selectedAgentSessionResult()?.owners,
    createdOrder: this.sessionProjection.createdOrder,
  });

  private sessionPeopleSortCapability(): boolean | undefined {
    const owners = this.selectedAgentSessionResult()?.owners;
    return owners ? owners.length >= 2 : undefined;
  }

  sessionPeopleSortAvailable(): boolean {
    return this.sessionPeopleSortCapability() === true;
  }

  effectiveSessionSortMode(): SidebarSessionSortMode {
    // A refresh can temporarily invalidate the owner facet. Render Created
    // without discarding People until an authoritative single-owner list arrives.
    return resolveSidebarSessionSortMode(this.sessionSortMode, this.sessionPeopleSortAvailable());
  }

  effectiveSessionsGrouping(): SidebarSessionsGrouping {
    // Refreshes can temporarily invalidate the owner facet; retain the Person
    // preference so it returns with the authoritative multi-owner list.
    const grouping = this.sessionsGrouping;
    return grouping === "person" && !this.sessionPeopleSortAvailable() ? "category" : grouping;
  }

  setSessionSortMode(mode: SidebarSessionSortMode) {
    this.sessionSortMode = storeSidebarSessionSortMode(mode, this.sessionPeopleSortCapability());
  }

  private readonly sessionOwnerFilter = new SessionOwnerFilterController(this, () => this.context);

  sidebarSessionOwnerFilter() {
    return this.sessionOwnerFilter;
  }

  get sessionOwnerFilterId(): string | null {
    return this.sessionOwnerFilter.ownerId;
  }

  get sessionInvolvingMeFilterActive(): boolean {
    return this.sessionOwnerFilter.involvingMe;
  }

  sessionOwnerOptions: readonly SessionOwnerOption[] = [];
  protected activeSessionOwnerId: string | null = null;
  get sessionOwnerFilterActive() {
    return this.sessionOwnerFilter.ownerId !== null;
  }
  sessionOwnershipVisibility = { filters: false, avatars: false };

  @state() selectedSessionKeys: ReadonlySet<string> = new Set();
  @state() sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  @state() sessionsShowCron = loadStoredSidebarSessionsShowCron();
  @state() sessionsShowPreview = loadStoredSidebarSessionsShowPreview();
  @state() sessionsShowSystem = loadStoredSidebarSessionsShowSystem();
  private readonly emptyGroups = new SidebarEmptyGroupsController(this, () => this.context);

  get sessionsEmptyGroupsMode(): SidebarEmptyGroupsMode {
    return this.emptyGroups.mode;
  }

  setSessionsEmptyGroupsMode(mode: SidebarEmptyGroupsMode): void {
    this.emptyGroups.set(mode);
  }
  @state() sessionsStatusFilter: SidebarSessionStatusFilter =
    loadStoredSidebarSessionStatusFilter();
  @state() hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();

  visibleSessionCatalogs = () =>
    visibleSessionCatalogProjection(
      excludeSessionCatalogRows(
        this.sessionData.sessionCatalogs,
        this.sessionData.pendingCatalogArchives,
      ),
      this.hiddenSessionCatalogIds,
      this.sessionsStatusFilter === "archived",
    );

  protected catalogLiveRows = () => [
    ...(this.sessionData.sessionsResult?.sessions ?? []),
    ...Object.values(this.sessionData.sessionResultsByAgent).flatMap((result) => result.sessions),
  ];

  protected sidebarSessionCatalogs = () =>
    projectSidebarSessionCatalogs(
      this.visibleSessionCatalogs(),
      this.activeSessionOwnerId,
      this.catalogLiveRows(),
    );

  sessionCatalogIdsWithoutVisibleRows = (): string[] => {
    const visibleIds = new Set(this.sidebarSessionCatalogs().map((catalog) => catalog.id));
    return this.visibleSessionCatalogs()
      .filter((catalog) => !visibleIds.has(catalog.id))
      .map((catalog) => catalog.id);
  };

  private sessionSelectionAnchor: string | null = null;
  private readonly runtimeSampledAtByRow = new WeakMap<GatewaySessionRow, number>();
  private readonly attention = new SessionAttentionController(this);

  declare readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  declare readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  declare readonly sessionOrganizer: SessionOrganizerController;
  declare readonly sidebarMenus: SidebarMenusController;

  get sessionAttentionContext() {
    return this.context;
  }

  get sessionDataContext() {
    return this.context;
  }

  get collapsedSessionSections(): ReadonlySet<string> {
    return this.sessionOrganizer.collapsedSessionSections;
  }

  dismissTransientMenus(): boolean {
    return this.sidebarMenus.dismissTransientMenus();
  }

  protected closeAgentMenu(options?: { restoreFocus?: boolean }): void {
    this.sidebarMenus.closeAgentMenu(options);
  }

  promoteCreatedSession(sessionKey: string) {
    if (this.sessionProjection.promoteCreatedSession(sessionKey)) {
      this.requestUpdate();
    }
  }

  protected override willUpdate(changedProperties: PropertyValues<this>) {
    if (this.emptyGroups.reconcile() && this.sidebarMenus.sessionSortMenuPosition) {
      this.sidebarMenus.closeSessionSortMenu();
    }
    super.willUpdate(changedProperties);
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    if (this.sessionSortMode === "people" && this.sessionPeopleSortCapability() === false) {
      this.setSessionSortMode("created");
    }
    const activeRouteKey = isSessionRouteId(this.activeRouteId) ? this.getRouteSessionKey() : "";
    if (isSessionRouteId(this.activeRouteId)) {
      void this.sessionData.loadActiveSessionLineage(activeRouteKey);
    }
    scheduleSidebarChildSessions(this.sessionData, () => this.childSessionParents());
  }

  private childSessionParents(): Set<string> {
    const revalidating = new Set<string>();
    const pending = [...this.visibleSessionRowsInOrder()];
    while (pending.length > 0) {
      const session = pending.shift();
      if (!session) {
        continue;
      }
      pending.push(...session.children);
      if (
        (session.childLoadParentKeys?.length ?? 0) > 0 &&
        (session.visuallyActive || this.isSessionChildrenExpanded(session))
      ) {
        for (const key of session.childLoadParentKeys ?? [session.key]) {
          revalidating.add(key);
        }
      }
    }
    const grouped = this.groupedSessionSource;
    const homeAgents = grouped
      ? grouped.agentIds.filter((id) => !grouped.collapsedAgentIds.has(id))
      : [this.expandedAgentId()];
    for (const agentId of homeAgents) {
      const mainRow = this.mainSessionRow(agentId);
      if (mainRow?.childSessions?.length) {
        for (const key of this.projectHomeSession(mainRow, agentId).childLoadParentKeys ?? []) {
          revalidating.add(key);
        }
      }
    }
    return revalidating;
  }

  setSessionOwnerFilter = (ownerId: string | null, involvingMe = false) =>
    this.sessionOwnerFilter.set(ownerId, involvingMe);

  protected applySessionOwnerFilter(
    projected: SidebarRecentSession[],
    ownerFacet: SessionsListResult["owners"],
  ): SidebarRecentSession[] {
    const result = applySidebarSessionOwnerFilter({
      projected,
      ownerFacet,
      selectedOwnerId: this.sessionOwnerFilterId,
      self: this.context?.gateway.snapshot.selfUser,
    });
    this.sessionOwnerFilter.observeOwnerFacet(ownerFacet !== undefined, result.ownerOptions);
    this.sessionOwnerOptions = result.ownerOptions;
    this.sessionOwnershipVisibility = result.ownershipVisibility;
    this.activeSessionOwnerId = result.activeOwnerId;
    return result.rows;
  }

  public getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  getSessionNavigationState(): SidebarSessionNavigationState {
    const routeSessionKey = this.getRouteSessionKey();
    const navigation = buildSidebarSessionNavigationState({
      context: this.context,
      routeSessionKey,
      sessionsResult: this.groupedSessionSource?.result ?? this.sessionData.sessionsResult,
      activeSession: findActiveSidebarLineageRow(this.sessionData, routeSessionKey),
      sessionsAgentId: this.sessionData.sessionsAgentId,
      showCron: this.sessionsShowCron,
      showSystem: this.sessionsShowSystem,
      statusFilter: this.sessionsStatusFilter,
      compareSessions: createSidebarSessionRowsComparator(this.readSidebarSessionSortOptions),
      highlightCurrentSession: isSessionRouteId(this.activeRouteId),
      runtimeSampledAtByRow: this.runtimeSampledAtByRow,
      loadingChildSessionKeys: this.sessionData.loadingChildSessionKeys,
      outboxAttentionCountForSessionKey: this.outboxAttentionCountForSession,
      hasSessionDraft: (sessionKey) => this.hasSessionDraft(sessionKey),
      resolveAttention: (row) => this.attention.resolveSessionAttention(row),
      resolveAgentStatusNote: (row) => this.attention.resolveSessionAgentStatus(row)?.note,
    });
    if (this.groupedSessionSource) {
      const rows = this.groupedSessionSource.result?.sessions ?? [];
      const current = navigation.visibleSessionRows.find(
        (row) => row.key === navigation.activeRowKey,
      );
      navigation.visibleSessionRows =
        current && !rows.some((row) => row.key === current.key) ? [...rows, current] : [...rows];
    }
    return navigation;
  }

  selectedAgentIdForSessions(): string {
    return this.getSessionNavigationState().selectedAgentId;
  }

  private sessionNavigationAgentId(session: Pick<SidebarRecentSession, "key" | "agentId">): string {
    if (this.sidebarAgentsMode !== "roster") {
      return this.selectedAgentIdForSessions();
    }
    return resolveUiSessionRowAgentId(
      session,
      resolveUiDefaultAgentId({
        agentsList: this.context?.agents.state.agentsList,
        hello: this.context?.gateway.snapshot.hello,
      }),
    );
  }

  sidebarSessionHref(session: SidebarRecentSession): string {
    // Build links only for rendered rows, after full-roster projection and pagination.
    return sessionNavigationTarget({
      face: resolveSessionPreferredFace(session),
      sessionKey: session.key,
      fallbackAgentId: this.sessionNavigationAgentId(session),
      basePath: this.context?.basePath ?? "",
      row: session,
      mainKey: this.context ? this.sessionMainKey() : undefined,
      preferenceDerivedFace: true,
    }).href;
  }

  sidebarSessionStatusFilter(): SidebarSessionStatusFilter {
    return this.sessionsStatusFilter;
  }

  readonly selectSession = (sessionKey: string, mainAgentId?: string) => {
    const navigationState = this.getSessionNavigationState();
    const sessionResultsByAgent = this.sessionData.sessionResultsByAgent;
    const row = findProjectedSidebarSession({ sessionKey, navigationState, sessionResultsByAgent });
    const mainChat = mainAgentId !== undefined && this.sidebarAgentsMode === "roster";
    const face = mainChat ? "chat" : resolveSessionPreferredFace(row);
    const agentId = mainAgentId ?? this.sessionNavigationAgentId(row ?? { key: sessionKey });
    const target = sessionNavigationTarget({
      face,
      sessionKey,
      fallbackAgentId: agentId,
      basePath: this.basePath,
      row,
      mainKey: this.sessionMainKey(),
      preferenceDerivedFace: !mainChat,
      navigationKey: sessionKey,
    });
    runSessionNavigationIntent(this, {
      commit: () => {
        if (this.sidebarAgentsMode === "roster") {
          this.expandAgent(agentId);
        }
        this.prepareSessionNavigation(sessionKey, target.options.pathname);
        this.onNavigate?.(face, target.options);
        this.bindLiteralSession(sessionKey, agentId, target.options);
        return true;
      },
      face,
      sessionKey,
    });
  };

  /** Collapsed zones keep full rows for true header counts and status dots. */
  protected zonedVisibleSections(
    rows: SidebarRecentSession[],
    catalogs = this.sidebarSessionCatalogs(),
  ): SidebarVisibleSections {
    const grouping = this.effectiveSessionsGrouping();
    const roster = this.groupedSessionSource;
    const sections = roster?.agentIds.flatMap((agentId) => {
      const agentRows = rows.filter((row) => this.sessionNavigationAgentId(row) === agentId);
      return [true, false].map((pinned) => ({
        id: `agent:${agentId}:${pinned ? "pinned" : "recent"}` as const,
        rows: agentRows.filter((row) => row.pinned === pinned),
      }));
    });
    const collapsedSections = new Set(this.collapsedSessionSections);
    for (const agentId of roster?.collapsedAgentIds ?? []) {
      collapsedSections.add(`agent:${agentId}:pinned`);
      collapsedSections.add(`agent:${agentId}:recent`);
    }
    return this.sessionProjection.project({
      rows,
      sections,
      grouping,
      knownGroups: grouping === "category" ? this.knownSessionGroups() : [],
      selfOwnerId: this.context?.gateway.snapshot.selfUser?.id ?? null,
      // Normalize gateway order without dropping catalog-lagging categories.
      sectionOrder: this.knownSectionOrder(),
      catalogIds: catalogs.map((catalog) => catalog.id),
      collapsedSections,
      emptyGroupsMode: this.sessionsEmptyGroupsMode,
      ownerFiltered: this.sessionOwnerFilterActive || this.sessionInvolvingMeFilterActive,
      visibleSessionLimits: roster
        ? this.rosterVisibleSessionLimits
        : this.sessionData.visibleSessionLimits,
      sortMode: this.effectiveSessionSortMode(),
      statusFilter: this.sessionsStatusFilter,
      agentId: roster ? "*" : this.expandedAgentId(),
      connectionIdentity:
        this.context?.gateway.snapshot.phase === "connected"
          ? (this.context.gateway.snapshot.client ?? null)
          : null,
      listSource: this.context?.sessions ?? null,
      subtitle: {
        sidebarLiveActivity: this.sidebarLiveActivity,
        showPreview: this.sessionsShowPreview,
        narrationLines: this.sidebarNarrationLines,
        observerDigests: this.sidebarObserverDigests,
      },
    });
  }

  reconciledSidebarZone(rows = this.selectedAgentSessionRows(this.getSessionNavigationState())) {
    return buildReconciledSidebarZone({
      sidebarEntries: this.sidebarEntries,
      rows,
      pluginNavigation: this.pluginNavigation(),
      pluginTabs: this.context?.gateway.snapshot.hello?.controlUiTabs,
    });
  }

  /**
   * Drop one session entry from the persisted zone order (raw list, no
   * reconcile-pruning). Only sidebar-driven unpins call this; other surfaces
   * (e.g. the Sessions page) rely on reconcileSidebarZone's known-unpinned
   * pruning at the next canonical write, which keeps the slot hidden meanwhile.
   */
  pruneSidebarSessionEntry(key: string) {
    const serialized = serializeSidebarEntry({ type: "session", key });
    if (!this.sidebarEntries.includes(serialized)) {
      return;
    }
    this.onUpdateSidebarEntries?.(this.sidebarEntries.filter((entry) => entry !== serialized));
  }

  /** Rows in on-screen order; shift ranges and batch actions share this ordering. */
  protected visibleSessionRowsInOrder(): SidebarRecentSession[] {
    const navigationState = this.getSessionNavigationState();
    const rows = this.selectedAgentSessionRows(navigationState);
    const { visibleRows } = this.zonedVisibleSections(rows);
    const { entries, sessionRows } = this.reconciledSidebarZone(rows);
    const pinnedRows = entries.flatMap((entry) => {
      const row = entry.type === "session" ? sessionRows.get(entry.key) : undefined;
      return row ? [row] : [];
    });
    return this.groupedSessionSource ? visibleRows : [...pinnedRows, ...visibleRows];
  }

  selectedVisibleSessions(): SidebarRecentSession[] {
    if (this.selectedSessionKeys.size === 0) {
      return [];
    }
    return this.visibleSessionRowsInOrder().filter((row) => this.selectedSessionKeys.has(row.key));
  }

  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession) {
    if (session.isChild && shouldHandleNavigationClick(event)) {
      event.preventDefault();
      this.clearSessionSelection();
      this.selectSession(session.key);
      return;
    }
    if (session.isChild || event.defaultPrevented || event.button !== 0) {
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      this.extendSessionSelection(session.key);
      return;
    }
    if (event.altKey) {
      event.preventDefault();
      this.toggleSessionSelected(session.key);
      return;
    }
    event.preventDefault();
    this.clearSessionSelection();
    this.selectSession(session.key);
  }

  private toggleSessionSelected(key: string) {
    const selection = toggleSidebarSessionSelection(this.selectedSessionKeys, key);
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
  }

  private extendSessionSelection(key: string) {
    const selection = extendSidebarSessionSelection({
      rows: this.visibleSessionRowsInOrder(),
      anchor: this.sessionSelectionAnchor,
      key,
    });
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
  }

  clearSessionSelection() {
    this.sessionSelectionAnchor = null;
    if (this.selectedSessionKeys.size > 0) {
      this.selectedSessionKeys = new Set();
    }
  }

  /** Chip switching selects the agent for the application. */
  protected readonly expandAgent = (agentId: string) => {
    const context = this.context;
    if (!context) {
      return;
    }
    const nextAgentId = normalizeAgentId(agentId);
    if (nextAgentId === normalizeAgentId(this.expandedAgentId())) {
      if (this.sidebarAgentsMode !== "roster") {
        context.agentSelection.setScope(nextAgentId);
      }
      return;
    }
    this.clearSessionSelection();
    if (this.sidebarAgentsMode !== "roster") {
      this.sessionProjection.resetMembership();
      this.sessionData.visibleSessionLimits.clear();
    }
    context.agentSelection.set(nextAgentId);
  };

  expandedAgentId(): string {
    const selected = normalizeOptionalString(this.context?.agentSelection.state.selectedId);
    return normalizeAgentId(selected || this.getSessionNavigationState().selectedAgentId);
  }

  activeChipAgent() {
    return resolveActiveSidebarAgent({
      activeId: this.expandedAgentId(),
      roster: this.context?.agents.state.agentsList?.agents ?? [],
      identities: this.context?.agentIdentity.entries() ?? [],
    });
  }

  /** Newest visible session for an agent; the chip menu resumes here. */
  private latestAgentSessionRow(agentId: string): SessionsListResult["sessions"][number] | null {
    return resolveLatestSidebarAgentSession({
      agentId,
      sessionData: this.sessionData,
      context: this.context,
    });
  }

  private agentResumeKey(agentId: string): string {
    const latest = this.latestAgentSessionRow(agentId);
    return resolveSidebarAgentResumeKey(latest, agentId, this.sessionMainKey());
  }

  /** Offline routes to Settings instead of a dead chat load. */
  private openAgentConversation(agentId: string) {
    if (!this.connected) {
      this.onNavigate?.("appearance");
      return;
    }
    this.selectSession(this.agentResumeKey(agentId));
  }

  switchChipAgent(agentId: string) {
    this.closeAgentMenu();
    this.expandAgent(agentId);
    // Skills uses the shared agent selection in place; opening chat would
    // discard the discovery page instead of updating its workspace scope.
    if (this.activeRouteId !== "skills") {
      this.openAgentConversation(agentId);
    }
  }

  askAgentCapabilities(agentId: string) {
    this.closeAgentMenu();
    if (!this.connected) {
      return;
    }
    const key = this.agentResumeKey(agentId);
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: key,
      fallbackAgentId: agentId,
      basePath: this.basePath,
      row: this.findSidebarSessionByKey(key),
      mainKey: this.sessionMainKey(),
    });
    this.setApplicationSession(key, this.selectedAgentIdForSessions());
    this.onNavigate?.("chat", {
      ...target.options,
      search: composerDraftSearch(t("chat.welcome.suggestions.whatCanYouDo")),
    });
  }

  knownSessionGroups(): string[] {
    return collectKnownSidebarSessionGroups(
      this.context?.sessions.state.groups ?? [],
      this.sessionData.sessionsResult?.sessions ?? [],
    );
  }

  readonly knownSectionOrder = () => [...(this.context?.sessions.state.sectionOrder ?? [])];

  knownSessionCatalogIds(): string[] {
    return collectKnownSidebarSessionCatalogIds({
      loadedCatalogIds: this.sessionData.sessionCatalogs.map((catalog) => catalog.id),
      hasLoaded: this.sessionData.sessionCatalogRefreshStatus.hasLoaded,
      sectionOrder: this.knownSectionOrder(),
    });
  }

  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    const navigationState = this.getSessionNavigationState();
    return findProjectedSidebarSession({
      sessionKey,
      navigationState,
      sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
    });
  }

  findSidebarHovercardRowByKey(sessionKey: string) {
    return findSidebarHovercardRow(this, sessionKey);
  }

  /** The list follows the chip-selected agent without flashing stale rows mid-switch. */
  protected selectedAgentSessionRows(
    navigationState: SidebarSessionNavigationState,
  ): SidebarRecentSession[] {
    const roster = this.groupedSessionSource;
    const selected = this.expandedAgentId();
    const projected = projectSidebarAgentSessionRows({
      host: this,
      navigationState,
      selected,
      agentIds: roster?.agentIds ?? [selected],
      result: roster?.result,
      compareSessions: createSidebarSessionRowsComparator(this.readSidebarSessionSortOptions),
      knownSessionAttention: this.attention.knownSessionAttention(),
    });
    return this.applySessionOwnerFilter(projected, this.selectedAgentSessionResult()?.owners);
  }

  private selectedAgentSessionResult(): SessionsListResult | null {
    if (this.groupedSessionSource) {
      return this.groupedSessionSource.result;
    }
    const selected = this.expandedAgentId();
    return selected === normalizeAgentId(this.sessionData.sessionsAgentId ?? "")
      ? this.sessionData.sessionsResult
      : (this.sessionData.sessionResultsByAgent[selected] ?? null);
  }

  /** Canonical main-session key for the selected (or given) agent. */
  selectedAgentMainSessionKey(agentId?: string): string {
    return resolveSidebarMainSessionKey({
      agentId: agentId ?? this.expandedAgentId(),
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  resolveHomeSessionAttention(sessionKey: string, row: GatewaySessionRow | null) {
    return resolveSidebarHomeAttention(this.attention, sessionKey, row);
  }

  projectHomeSession(row: GatewaySessionRow, agentId: string): SidebarRecentSession {
    return projectSidebarHomeSession({
      host: this,
      row,
      agentId,
      result: this.groupedSessionSource?.result,
      navigationState: this.getSessionNavigationState(),
      knownSessionAttention: this.attention.knownSessionAttention(),
    });
  }

  /** Gateway row backing the identity card (unread/running state), if loaded. */
  mainSessionRow(agentId?: string): GatewaySessionRow | null {
    const normalized = normalizeAgentId(agentId ?? this.expandedAgentId());
    const mainKey = this.selectedAgentMainSessionKey(normalized);
    const rows =
      this.groupedSessionSource?.result?.sessions ??
      (normalized === normalizeAgentId(this.sessionData.sessionsAgentId ?? "")
        ? (this.sessionData.sessionsResult?.sessions ?? [])
        : (this.sessionData.sessionResultsByAgent[normalized]?.sessions ?? []));
    const lineage = this.sessionData.activeSessionLineageRoot;
    return findSidebarMainSessionRow(lineage ? [...rows, lineage] : rows, mainKey);
  }

  /** Identity-card click: the agent's rolling main session, or Settings offline. */
  readonly openMainSession = (agentId: string) => {
    if (!this.connected) {
      this.onNavigate?.("appearance");
      return;
    }
    this.clearSessionSelection();
    const mainAgentId = normalizeAgentId(agentId);
    this.selectSession(this.selectedAgentMainSessionKey(mainAgentId), mainAgentId);
  };

  isSessionChildrenExpanded(session: SidebarRecentSession): boolean {
    return this.sessionProjection.isChildrenExpanded(session.key);
  }

  isSessionChildrenFullyShown(sessionKey: string): boolean {
    return this.sessionProjection.isChildrenFullyShown(sessionKey);
  }

  toggleSessionChildren(session: SidebarRecentSession) {
    const { expanded } = this.sessionProjection.toggleChildren(session);
    for (const key of session.childLoadParentKeys ?? [session.key]) {
      if (expanded) {
        this.sessionData.retryChildSessions(key);
      } else {
        this.sessionData.discardEmptyChildSessionSnapshot(key);
      }
    }
    this.requestUpdate();
  }

  showMoreChildren(sessionKey: string) {
    this.sessionProjection.showMoreChildren(sessionKey);
    this.requestUpdate();
  }

  agentUnreadCount(agentId: string): number {
    const rows = this.sessionData.sessionResultsByAgent[normalizeAgentId(agentId)]?.sessions ?? [];
    return rows.filter((row) => row.unread === true && row.archived !== true).length;
  }
}
