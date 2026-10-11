import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { serializeSidebarEntry } from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import {
  collectKnownSessionGroups,
  type SidebarSessionsGrouping,
} from "../lib/sessions/grouping.ts";
import { runSessionNavigationIntent } from "../lib/sessions/navigation-handoff.ts";
import {
  composerDraftSearch,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiDefaultAgentId,
  resolveUiSessionRowAgentId,
} from "../lib/sessions/session-key.ts";
import {
  projectSidebarAgentSessionRows,
  type SidebarHomeSession,
} from "./app-sidebar-agent-session-rows.ts";
import { AppSidebarBase } from "./app-sidebar-base.ts";
import { scheduleSidebarChildSessions } from "./app-sidebar-child-session-data.ts";
import {
  personalSidebarZone,
  SidebarPinnedSessions,
  personalSidebarOwnerProjection,
  personalSidebarOwnerFilterId,
  projectUnpinnedSessionRows,
} from "./app-sidebar-personal-navigation.ts";
import {
  adoptedCatalogSessionKeys,
  type SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import {
  findSidebarHovercardRow,
  mergeAdoptedSessionPullRequestRows,
} from "./app-sidebar-session-lookup.ts";
import {
  createSidebarSessionRowsComparator,
  collectKnownSidebarSessionCatalogIds,
  extendSidebarSessionSelection,
  findProjectedSidebarSession,
  findSidebarSessionInTree,
  projectSidebarVisibleMainSession,
  resolveActiveSidebarAgent,
  resolveLatestSidebarAgentSession,
  resolveSidebarMainSessionKey,
  toggleSidebarSessionSelection,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import {
  SidebarSessionProjection,
  type SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import {
  visibleSidebarSessionCatalogs,
  sidebarCatalogLiveRows,
  sidebarChildSessionParents,
  sidebarSessionSnoozeWakeRows,
} from "./app-sidebar-session-snooze-visibility.ts";
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
  type SidebarToolActivity,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { SessionAttentionController } from "./session-attention-controller.ts";
import { SessionDataController } from "./session-data-controller.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";
import { SidebarEmptyGroupsController } from "./sidebar-empty-groups-controller.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";
import { SidebarNavigationCatalog } from "./sidebar-navigation-catalog.ts";
import {
  memoizedSidebarCatalogs,
  memoizedSidebarHome,
  memoizedSidebarSections,
  projectSidebarNavigation,
  sidebarNavigationInputs,
  sidebarRowsInputs,
  SidebarProjectionMemo,
} from "./sidebar-projection-memo.ts";
import { restoreSnapshotSections, restoreSnapshotSession } from "./sidebar-snapshot-model.ts";

type SidebarRosterSessionSource = {
  result: SessionsListResult | null;
  agentIds: readonly string[];
  collapsedAgentIds: ReadonlySet<string>;
} | null;

export abstract class AppSidebarSessionNavigationElement extends AppSidebarBase {
  rosterSessionSource: SidebarRosterSessionSource = null;

  protected rosterVisibleSessionLimits = new Map<string, number>();

  private get groupedSessionSource() {
    return this.sidebarAgentsMode === "roster" ? this.rosterSessionSource : null;
  }

  sessionSortMode: SidebarSessionSortMode = loadStoredSidebarSessionSortMode();

  readonly pinnedSessions = new SidebarPinnedSessions(this);
  readonly sessionProjection = new SidebarSessionProjection(undefined, this);
  private readonly navigationMemo = new SidebarProjectionMemo<SidebarSessionNavigationState>();
  private readonly rowsMemo = new SidebarProjectionMemo<SidebarRecentSession[]>();
  private readonly catalogsMemo = new SidebarProjectionMemo<SidebarSessionCatalog[]>();
  private readonly sectionsMemo = new SidebarProjectionMemo<SidebarVisibleSections>();
  private readonly homeMemos = new Map<string, SidebarProjectionMemo<SidebarHomeSession>>();
  readonly sessionOwnerFilter = new SessionOwnerFilterController(
    this,
    () => this.context,
    () =>
      this.context?.sessions.listSnapshot(
        this.sessionData.sessionListQuery(this.expandedAgentId()),
      ),
  );
  readonly sessionData = new SessionDataController(this);
  readonly navigationCatalog = new SidebarNavigationCatalog(this, () => this.context);
  readonly sessionPullRequests = new SessionPullRequestIndicatorsController(this, {
    getConnected: () => this.connected,
    getRows: () =>
      mergeAdoptedSessionPullRequestRows({
        rows: [
          ...this.visibleSessionRowsInOrder(),
          ...(this.groupedSessionSource?.agentIds.flatMap((agentId) => {
            const home = this.visibleHomeSession(agentId);
            return home ? [home] : [];
          }) ?? []),
        ],
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
    return this.sessionPeopleSortCapability() !== false;
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
    this.requestUpdate();
  }

  sidebarSessionOwnerFilter() {
    return { ownerId: this.sessionOwnerFilterId, involvingMe: this.sessionInvolvingMeFilterActive };
  }

  get sessionOwnerFilterId(): string | null {
    return personalSidebarOwnerFilterId(this);
  }

  sessionOwnerOptions: readonly SessionOwnerOption[] = [];
  protected activeSessionOwnerId: string | null = null;
  get sessionOwnerFilterActive() {
    return this.sessionOwnerFilterId !== null;
  }
  sessionOwnershipVisibility = { filters: false, avatars: false };

  selectedSessionKeys: ReadonlySet<string> = new Set();
  sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  sessionsShowCron: boolean = loadStoredSidebarSessionsShowCron();
  sessionsShowPreview: boolean = loadStoredSidebarSessionsShowPreview();
  sessionsShowSystem: boolean = loadStoredSidebarSessionsShowSystem();
  private readonly emptyGroups = new SidebarEmptyGroupsController(this, () => this.context);

  get sessionsEmptyGroupsMode(): SidebarEmptyGroupsMode {
    return this.emptyGroups.mode;
  }

  setSessionsEmptyGroupsMode(mode: SidebarEmptyGroupsMode): void {
    this.emptyGroups.set(mode);
  }
  sessionsStatusFilter: SidebarSessionStatusFilter = loadStoredSidebarSessionStatusFilter();
  hiddenSessionCatalogIds: ReadonlySet<string> = loadStoredHiddenSessionCatalogIds();

  // Adopted-key exclusion and rendering share this projection so hidden catalogs
  // never remove their adopted rows from the regular session list.
  visibleSessionCatalogs = () => visibleSidebarSessionCatalogs(this);

  protected catalogLiveRows = () => sidebarCatalogLiveRows(this.sessionData);

  protected sidebarSessionCatalogs = () => {
    // Catalogs consume the rows stage's resolved owner.
    this.selectedAgentSessionRows(this.getSessionNavigationState());
    return memoizedSidebarCatalogs(this.catalogsMemo, this, this.activeSessionOwnerId);
  };

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
  declare readonly sidebarTools: ReadonlyMap<string, SidebarToolActivity>;
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

  promoteCreatedSession(sessionKey: string) {
    if (this.sessionProjection.promoteCreatedSession(sessionKey)) {
      this.requestUpdate();
    }
  }

  protected override willUpdate() {
    if (this.emptyGroups.reconcile() && this.sidebarMenus.sessionSortMenuPosition) {
      this.sidebarMenus.closePositionedMenu("sessionSort");
    }
    super.willUpdate();
  }

  override disconnectedCallback() {
    this.sessionProjection.dispose();
    this.homeMemos.clear();
    super.disconnectedCallback();
  }

  override updated() {
    super.updated();
    if (this.sessionSortMode === "people" && this.sessionPeopleSortCapability() === false) {
      this.setSessionSortMode("created");
    }
    if (isSessionRouteId(this.activeRouteId)) {
      void this.sessionData.loadActiveSessionLineage(this.getRouteSessionKey());
    }
    scheduleSidebarChildSessions(this.sessionData, () => this.childSessionParents());
  }

  private childSessionParents(): Set<string> {
    const rows = this.visibleSessionRowsInOrder();
    const grouped = this.groupedSessionSource;
    const homeAgents = grouped
      ? grouped.agentIds.filter((id) => !grouped.collapsedAgentIds.has(id))
      : [this.expandedAgentId()];
    return sidebarChildSessionParents(rows, homeAgents, this);
  }

  protected applySessionOwnerFilter(
    projected: SidebarRecentSession[],
    ownerFacet: SessionsListResult["owners"],
  ): SidebarRecentSession[] {
    const result = personalSidebarOwnerProjection(this, projected, ownerFacet);
    const agentId = this.sidebarAgentsMode === "roster" ? "*" : this.expandedAgentId();
    this.sessionOwnerFilter.observeOwnerFacet(agentId, ownerFacet && result.ownershipVisibility);
    this.sessionOwnerOptions = result.ownerOptions;
    this.sessionOwnershipVisibility = result.ownershipVisibility;
    this.activeSessionOwnerId = result.activeOwnerId;
    return result.rows;
  }

  public getRouteSessionKey(): string {
    return this.sessionKey.trim() || this.context?.gateway.snapshot.sessionKey.trim() || "";
  }

  getSessionNavigationState(): SidebarSessionNavigationState {
    const data = this.sessionData;
    const currentResult = this.groupedSessionSource?.result ?? data.sessionsResult;
    this.sessionProjection.observeRows([
      ...(currentResult ? [currentResult] : []),
      ...Object.values(data.sessionResultsByAgent),
    ]);
    return this.navigationMemo.read(
      () => sidebarNavigationInputs(this, currentResult),
      () =>
        projectSidebarNavigation(
          this,
          createSidebarSessionRowsComparator(this.readSidebarSessionSortOptions),
          this.runtimeSampledAtByRow,
          (row) => this.attention.resolveSessionAgentStatus(row)?.note,
        ),
    );
  }

  selectedAgentIdForSessions = (): string => this.getSessionNavigationState().selectedAgentId;

  sessionNavigationAgentId(session: Pick<SidebarRecentSession, "key" | "agentId">): string {
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

  readonly selectSession = (
    sessionKey: string,
    mainAgentId?: string,
    resolvedRow?: SidebarRecentSession,
  ) => {
    const row = resolvedRow ?? this.findSidebarSessionByKey(sessionKey);
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
      agentId,
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
  protected zonedVisibleSections(rows: SidebarRecentSession[]): SidebarVisibleSections {
    if (this.sidebarSnapshot) {
      return restoreSnapshotSections(this.sidebarSnapshot, this.getRouteSessionKey());
    }
    return memoizedSidebarSections(
      this.sectionsMemo,
      this,
      rows,
      this.sidebarSessionCatalogs(),
      this.rosterVisibleSessionLimits,
    );
  }

  reconciledSidebarZone(rows = this.selectedAgentSessionRows(this.getSessionNavigationState())) {
    return personalSidebarZone(this, rows);
  }

  /** Explicit personal unpins remove a reference, never shared session metadata. */
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
    return [...pinnedRows, ...visibleRows];
  }

  selectedVisibleSessions(): SidebarRecentSession[] {
    if (this.selectedSessionKeys.size === 0) {
      return [];
    }
    return this.visibleSessionRowsInOrder().filter((row) => this.selectedSessionKeys.has(row.key));
  }

  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession) {
    if (
      session.isChild
        ? !shouldHandleNavigationClick(event)
        : event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
    ) {
      return;
    }
    if (!session.isChild && event.shiftKey) {
      event.preventDefault();
      this.extendSessionSelection(session.key);
      return;
    }
    if (!session.isChild && event.altKey) {
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
    this.requestUpdate();
  }

  private extendSessionSelection(key: string) {
    const selection = extendSidebarSessionSelection({
      rows: this.visibleSessionRowsInOrder(),
      anchor: this.sessionSelectionAnchor,
      key,
    });
    this.sessionSelectionAnchor = selection.anchor;
    this.selectedSessionKeys = selection.selectedKeys;
    this.requestUpdate();
  }

  clearSessionSelection() {
    this.sessionSelectionAnchor = null;
    if (this.selectedSessionKeys.size > 0) {
      this.selectedSessionKeys = new Set();
      this.requestUpdate();
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
      this.sessionData.visibleSessionLimits = new Map();
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

  private agentResumeKey(agentId: string): string {
    const latest = resolveLatestSidebarAgentSession({
      agentId,
      sessionData: this.sessionData,
      context: this.context,
    });
    return latest?.key ?? buildAgentMainSessionKey({ agentId, mainKey: this.sessionMainKey() });
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
    this.sidebarMenus.closeAgentMenu();
    this.expandAgent(agentId);
    // Skills uses the shared agent selection in place; opening chat would
    // discard the discovery page instead of updating its workspace scope.
    if (this.activeRouteId !== "skills") {
      this.openAgentConversation(agentId);
    }
  }

  askAgentCapabilities(agentId: string) {
    this.sidebarMenus.closeAgentMenu();
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
    runSessionNavigationIntent(this, {
      sessionKey: key,
      agentId,
      face: "chat",
      commit: () => {
        this.setApplicationSession(key, agentId);
        this.onNavigate?.("chat", {
          ...target.options,
          search: composerDraftSearch(t("chat.welcome.suggestions.whatCanYouDo")),
        });
        return true;
      },
    });
  }

  knownSessionGroups(): string[] {
    return collectKnownSessionGroups(
      this.sessionData.sessionsResult ? (this.context?.sessions.state.groups ?? []) : [],
      this.sessionData.sessionsResult?.sessions ?? [],
    );
  }

  readonly knownSectionOrder = () =>
    this.sessionData.sessionsResult ? [...(this.context?.sessions.state.sectionOrder ?? [])] : [];

  knownSessionCatalogIds(): string[] {
    return collectKnownSidebarSessionCatalogIds({
      loadedCatalogIds: this.sessionData.sessionCatalogs.map((catalog) => catalog.id),
      hasLoaded: this.sessionData.sessionCatalogRefreshStatus.hasLoaded,
      sectionOrder: this.knownSectionOrder(),
    });
  }

  findSidebarSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    return findProjectedSidebarSession({
      sessionKey,
      navigationState: this.getSessionNavigationState(),
      sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
    });
  }

  /** Menus act on folded hidden-run state, which only the rendered tree keeps. */
  findSidebarMenuSessionByKey(sessionKey: string): SidebarRecentSession | undefined {
    return (
      findSidebarSessionInTree(
        this.selectedAgentSessionRows(this.getSessionNavigationState()),
        (row) => row.key === sessionKey,
      ) ?? this.findSidebarSessionByKey(sessionKey)
    );
  }

  findSidebarHovercardRowByKey(sessionKey: string) {
    return findSidebarHovercardRow(
      this,
      sessionKey,
      this.selectedAgentSessionRows(this.getSessionNavigationState()),
    );
  }

  /** The list follows the chip-selected agent without flashing stale rows mid-switch. */
  protected selectedAgentSessionRows(
    navigationState: SidebarSessionNavigationState,
  ): SidebarRecentSession[] {
    if (this.sidebarSnapshot) {
      return this.sidebarSnapshot.sessions.map((row) =>
        restoreSnapshotSession(row, this.getRouteSessionKey()),
      );
    }
    const rows = this.rowsMemo.read(
      () => [...sidebarRowsInputs(this, navigationState), this.sidebarEntries],
      () => {
        const roster = this.groupedSessionSource;
        const selected = this.expandedAgentId();
        const projected = projectSidebarAgentSessionRows({
          host: this,
          navigationState,
          selected,
          agentIds: roster?.agentIds ?? [selected],
          result: roster?.result,
          compareSessions: createSidebarSessionRowsComparator(this.readSidebarSessionSortOptions),
          resolveAttention: this.resolveSessionAttention,
        });
        return this.applySessionOwnerFilter(
          projectUnpinnedSessionRows(projected),
          this.selectedAgentSessionResult()?.owners,
        );
      },
    );
    this.attention.scheduleSessionSnoozeWake(
      sidebarSessionSnoozeWakeRows(
        this.sessionData,
        this.selectedAgentSessionResult(),
        navigationState,
      ),
    );
    return rows;
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

  selectedAgentMainSessionKey(agentId?: string): string {
    return resolveSidebarMainSessionKey({
      agentId: agentId ?? this.expandedAgentId(),
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  get resolveSessionAttention() {
    return this.attention.createResolver();
  }

  projectHomeSession(row: GatewaySessionRow, agentId: string): SidebarHomeSession {
    let memo = this.homeMemos.get(agentId);
    if (!memo) {
      memo = new SidebarProjectionMemo<SidebarHomeSession>();
      this.homeMemos.set(agentId, memo);
    }
    return memoizedSidebarHome(memo, this, row, agentId);
  }

  /** Header metadata follows session filters; Home navigation and child hydration do not. */
  visibleHomeSession(agentId: string): SidebarRecentSession | null {
    return projectSidebarVisibleMainSession(this, agentId);
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
    return (
      (lineage ? [...rows, lineage] : rows).find((row) =>
        areUiSessionKeysEquivalent(row.key, mainKey),
      ) ?? null
    );
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
