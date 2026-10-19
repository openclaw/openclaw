import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { serializeSidebarEntry } from "../app-navigation.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createQuestionPromptState } from "../app/question-prompt.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { SessionOwnerOption } from "../lib/session-owner.ts";
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
import {
  personalSidebarZone,
  createSidebarPinnedSessions,
  personalSidebarOwnerProjection,
  personalSidebarOwnerFilterId,
  projectUnpinnedSessionRows,
} from "./app-sidebar-personal-navigation.ts";
import { sidebarPresenceScope } from "./app-sidebar-presence.ts";
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
  createSidebarSessionSelection,
  collectKnownSidebarSessionCatalogIds,
  findProjectedSidebarSession,
  findSidebarSessionInTree,
  projectSidebarVisibleMainSession,
  resolveActiveSidebarAgent,
  resolveLatestSidebarAgentSession,
  resolveSidebarMainSessionKey,
  type SidebarSessionNavigationState,
} from "./app-sidebar-session-navigation-logic.ts";
import type { SessionPullRequestIndicators } from "./app-sidebar-session-pr-indicators.ts";
import {
  SidebarSessionProjection,
  type SidebarVisibleSections,
} from "./app-sidebar-session-projection.ts";
import {
  visibleSidebarSessionCatalogs,
  sidebarCatalogLiveRows,
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
import type { SessionAttention } from "./session-attention.ts";
import { SessionDataOwner } from "./session-data.ts";
import type { SessionOrganizer } from "./session-organizer.ts";
import { SessionOwnerFilter } from "./session-owner-filter.ts";
import { SidebarEmptyGroupsPreference } from "./sidebar-empty-groups.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import type { SidebarNavigationCatalog } from "./sidebar-navigation-catalog.ts";
import { SidebarProjectionMemo, SidebarSessionRowProjection } from "./sidebar-projection-cache.ts";
import {
  memoizedSidebarCatalogs,
  memoizedSidebarHome,
  memoizedSidebarSections,
  projectSidebarNavigation,
  sidebarNavigationInputs,
  sidebarRowsInputs,
  type SidebarProjectionHost,
} from "./sidebar-projection-memo.ts";
import { restoreSnapshotSections, restoreSnapshotSession } from "./sidebar-snapshot-model.ts";
import { mountedViewerSessionKeys } from "./solid/viewer-facepile.tsx";

export abstract class AppSidebarSessionNavigationElement extends AppSidebarBase {
  readonly personCardTriggers = new WeakMap<HTMLElement, HTMLElement>();
  readonly presencePeople = new Map<string, HTMLElement>();

  mountedPresence() {
    return {
      sessionKeys: mountedViewerSessionKeys(this.hostElement),
      activityProfileIds: new Set(
        [...this.presencePeople.values()]
          .filter((element) => this.hostElement.contains(element))
          .map((element) => element.dataset.personCardKey?.slice("profile:".length) ?? ""),
      ),
    };
  }

  shouldPublishSessionData(): boolean {
    return this.sessionProjection.shouldPublishSessionData(this, {
      snapshot: Boolean(this.sidebarSnapshot),
      sections: () =>
        this.zonedVisibleSections(this.selectedAgentSessionRows(this.getSessionNavigationState()))
          .sections,
      tree: () => this.visibleSessionTreeInOrder(),
      catalogs: () => this.sidebarSessionCatalogs(),
      catalogRows: this.catalogLiveRows,
      ownerOptions: () => this.ownerOptions,
    });
  }

  private admittedRoster:
    | { context: ApplicationContext; collapsedAgentIds: ReadonlySet<string> }
    | undefined;
  private readonly rosterSourceMemo = new SidebarProjectionMemo<
    NonNullable<SidebarProjectionHost["rosterSessionSource"]>
  >();

  get rosterSessionSource() {
    const context = this.context;
    if (!context || this.sidebarAgentsMode !== "roster") {
      return null;
    }
    // Cache release and row projection read the same owner before the child renders.
    const { result, cards } = rosterActivityStore(context).snapshot;
    const agentIds = cards.map((card) => card.id);
    if (this.admittedRoster?.context !== context) {
      this.admittedRoster = undefined;
    }
    // Parked queries retain the card selection last presented by this owner.
    if (this.navigationVisible && this.navigationView === "sessions" && !this.contextualSidebar) {
      const visibleIds = (this.sidebarSnapshot?.cards ?? cards).map((card) => card.id);
      const previous = this.admittedRoster?.collapsedAgentIds;
      if (previous?.size !== visibleIds.length || visibleIds.some((id) => !previous.has(id))) {
        this.admittedRoster = { context, collapsedAgentIds: new Set(visibleIds) };
      }
    }
    const collapsedAgentIds = this.admittedRoster?.collapsedAgentIds;
    if (!collapsedAgentIds) {
      return null;
    }
    return this.rosterSourceMemo.read(
      () => [context, result, collapsedAgentIds, ...agentIds],
      () => ({ result, agentIds, collapsedAgentIds }),
    );
  }

  protected rosterVisibleSessionLimits = new Map<string, number>();

  sessionSortMode: SidebarSessionSortMode = loadStoredSidebarSessionSortMode();

  readonly pinnedSessions = createSidebarPinnedSessions(this);
  readonly sessionProjection = new SidebarSessionProjection();
  private readonly navigationMemo = new SidebarProjectionMemo<SidebarSessionNavigationState>();
  private readonly rowsMemo = new SidebarProjectionMemo<SidebarRecentSession[]>();
  private readonly catalogsMemo = new SidebarProjectionMemo<SidebarSessionCatalog[]>();
  private readonly sectionsMemo = new SidebarProjectionMemo<SidebarVisibleSections>();
  private readonly homeMemos = new Map<string, SidebarProjectionMemo<SidebarHomeSession>>();
  readonly sessionOwnerFilter = new SessionOwnerFilter(
    () => this.context?.gateway,
    () => this.invalidate(),
  );
  readonly sessionData = new SessionDataOwner(this, () => this.invalidate());

  samePresence(previous: PresencePayload | undefined, next: PresencePayload | undefined): boolean {
    return this.sessionProjection.samePresence(previous, next, sidebarPresenceScope(this));
  }

  refreshPresencePresentation(): void {
    this.sessionProjection.refreshPresencePresentation(this, sidebarPresenceScope(this));
  }

  abstract readonly navigationCatalog: SidebarNavigationCatalog;
  sessionPullRequests!: SessionPullRequestIndicators;

  readSessionPullRequestRows(): readonly SidebarRecentSession[] {
    return mergeAdoptedSessionPullRequestRows({
      rows: [
        ...this.visibleSessionRowsInOrder(),
        ...(this.rosterSessionSource?.agentIds.flatMap((agentId) => {
          const home = this.visibleHomeSession(agentId);
          return home ? [home] : [];
        }) ?? []),
      ],
      adopted: adoptedCatalogSessionKeys(this.visibleSessionCatalogs()),
      sessionsResult: this.rosterSessionSource?.result ?? this.sessionData.sessionsResult,
      sessionResultsByAgent: this.sessionData.sessionResultsByAgent,
      navigationState: this.getSessionNavigationState(),
    });
  }

  private readonly readSidebarSessionSortOptions = () => ({
    sortMode: this.effectiveSessionSortMode(),
    owners: this.selectedAgentSessionResult()?.owners,
    createdOrder: this.sessionProjection.createdOrder,
  });

  sessionPeopleSortAvailable(): boolean {
    const owners = this.selectedAgentSessionResult()?.owners;
    return !owners || owners.length >= 2;
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
    this.sessionSortMode = storeSidebarSessionSortMode(mode, this.sessionPeopleSortAvailable());
    this.invalidate();
  }

  sidebarSessionOwnerFilter() {
    return { ownerId: this.sessionOwnerFilterId, involvingMe: this.sessionInvolvingMeFilterActive };
  }

  get sessionOwnerFilterId(): string | null {
    return personalSidebarOwnerFilterId(this);
  }

  private ownerOptions: readonly SessionOwnerOption[] = [];

  get sessionOwnerOptions(): readonly SessionOwnerOption[] {
    this.selectedAgentSessionRows(this.getSessionNavigationState());
    return this.ownerOptions;
  }
  protected activeSessionOwnerId: string | null = null;
  get sessionOwnerFilterActive() {
    return this.sessionOwnerFilterId !== null;
  }
  sessionOwnershipVisibility = { filters: false, avatars: false };

  private readonly sessionSelection = createSidebarSessionSelection(
    () => this.visibleSessionRowsInOrder(),
    () => this.invalidate(),
  );
  get selectedSessionKeys(): ReadonlySet<string> {
    return this.sessionSelection.selectedKeys;
  }
  readonly clearSessionSelection = this.sessionSelection.clear;
  sessionsGrouping: SidebarSessionsGrouping = loadStoredSidebarSessionsGrouping();
  sessionsShowCron: boolean = loadStoredSidebarSessionsShowCron();
  sessionsShowPreview: boolean = loadStoredSidebarSessionsShowPreview();
  sessionsShowSystem: boolean = loadStoredSidebarSessionsShowSystem();
  private readonly emptyGroups = new SidebarEmptyGroupsPreference(() => this.context);

  get sessionsEmptyGroupsMode(): SidebarEmptyGroupsMode {
    return this.emptyGroups.mode;
  }

  setSessionsEmptyGroupsMode(mode: SidebarEmptyGroupsMode): void {
    this.emptyGroups.set(mode);
    this.invalidate();
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

  private readonly rowProjection = new SidebarSessionRowProjection();
  readonly attentionQuestions = createQuestionPromptState(() => {});
  declare attention: SessionAttention;

  abstract get sidebarNarrationLines(): ReadonlyMap<string, string>;
  abstract get sidebarTools(): ReadonlyMap<string, SidebarToolActivity>;
  abstract get sidebarObserverDigests(): ReadonlyMap<string, SessionObserverDigest>;
  declare readonly sessionOrganizer: SessionOrganizer;
  declare readonly sidebarMenus: SidebarMenus;

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
      this.invalidate();
    }
  }

  protected override willUpdate() {
    if (this.sidebarAgentsMode !== "roster") {
      this.admittedRoster = undefined;
    }
    if (this.emptyGroups.reconcile() && this.sidebarMenus.sessionSortMenuPosition) {
      // Menu state writes belong after the preparation memo commits.
      void this.updateComplete.then(
        (committed) => committed && this.sidebarMenus.closePositionedMenu("sessionSort"),
      );
    }
    super.willUpdate();
  }

  override disconnectedCallback() {
    this.sessionProjection.invalidate();
    this.homeMemos.clear();
    super.disconnectedCallback();
  }

  override updated() {
    super.updated();
    if (this.sessionSortMode === "people" && !this.sessionPeopleSortAvailable()) {
      this.setSessionSortMode("created");
    }
  }

  childSessionParents(): Set<string> {
    return this.sessionProjection.childSessionParents(this.visibleSessionRowsInOrder(), this);
  }

  protected applySessionOwnerFilter(
    projected: SidebarRecentSession[],
    ownerFacet: SessionsListResult["owners"],
  ): SidebarRecentSession[] {
    const result = personalSidebarOwnerProjection(this, projected, ownerFacet);
    const agentId = this.sidebarAgentsMode === "roster" ? "*" : this.expandedAgentId();
    this.sessionOwnerFilter.observeOwnerFacet(agentId, ownerFacet);
    this.ownerOptions = result.ownerOptions;
    this.sessionOwnershipVisibility = result.ownershipVisibility;
    this.activeSessionOwnerId = result.activeOwnerId;
    // A row event can precede the create response. Keep authoritative membership,
    // but render only the non-actionable handoff until the response admits it.
    const pendingKey = this.pendingSessionCreate()?.creation.sessionKey;
    return pendingKey ? result.rows.filter((row) => row.key !== pendingKey) : result.rows;
  }

  getSessionNavigationState(): SidebarSessionNavigationState {
    const data = this.sessionData;
    const currentResult = this.rosterSessionSource?.result ?? data.sessionsResult;
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
          this.rowProjection,
          (row) => this.attention.resolveSessionAgentStatus(row)?.note,
        ),
    );
  }

  selectedAgentIdForSessions = (): string => this.getSessionNavigationState().selectedAgentId;

  sessionNavigationAgentId(session: Pick<SidebarRecentSession, "key" | "agentId">): string {
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
    const rows = this.selectedAgentSessionRows(this.getSessionNavigationState());
    const { visibleRows } = this.zonedVisibleSections(rows);
    return this.sessionProjection.visibleRowsInOrder(this.reconciledSidebarZone(rows), visibleRows);
  }

  protected visibleSessionTreeInOrder(): SidebarRecentSession[] {
    return this.sessionProjection.visibleTree(this.visibleSessionRowsInOrder(), this);
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
      this.sessionSelection.extend(session.key);
      return;
    }
    if (!session.isChild && event.altKey) {
      event.preventDefault();
      this.sessionSelection.toggle(session.key);
      return;
    }
    event.preventDefault();
    this.clearSessionSelection();
    this.selectSession(session.key);
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
      result: this.selectedAgentSessionResult(agentId),
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

  /** Personal windows retain their configured-agent scope while the chat selection changes. */
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
        const roster = this.rosterSessionSource;
        const selected = this.expandedAgentId();
        const projected = projectSidebarAgentSessionRows({
          host: this,
          navigationState,
          selected,
          agentIds: roster?.agentIds ??
            (this.sessionData.sessionsAgentId === null
              ? this.context?.agents.state.agentsList?.agents.map((agent) => agent.id)
              : undefined) ?? [selected],
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

  private selectedAgentSessionResult(agentId = this.expandedAgentId()): SessionsListResult | null {
    if (this.rosterSessionSource) {
      return this.rosterSessionSource.result;
    }
    const selected = normalizeAgentId(agentId);
    return this.sessionData.sessionsAgentId === null ||
      selected === normalizeAgentId(this.sessionData.sessionsAgentId)
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
    return this.attention.readResolver();
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
    return this.sessionProjection.mainSessionRow(
      mainKey,
      this.selectedAgentSessionResult(normalized)?.sessions ?? [],
      this.sessionData.activeSessionLineageRoot,
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
    return this.sessionProjection.children.isExpanded(session.key);
  }

  isSessionChildrenFullyShown(sessionKey: string): boolean {
    return this.sessionProjection.children.isFullyShown(sessionKey);
  }

  toggleSessionChildren(session: SidebarRecentSession) {
    const { expanded } = this.sessionProjection.children.toggle(session.key);
    for (const key of session.childLoadParentKeys ?? [session.key]) {
      if (expanded) {
        this.sessionData.retryChildSessions(key);
      } else {
        this.sessionData.discardEmptyChildSessionSnapshot(key);
      }
    }
    this.invalidate();
  }

  showMoreChildren(sessionKey: string) {
    this.sessionProjection.children.showMore(sessionKey);
    this.invalidate();
  }

  agentUnreadCount(agentId: string): number {
    const normalized = normalizeAgentId(agentId);
    const rows = this.selectedAgentSessionResult(normalized)?.sessions ?? [];
    return this.sessionProjection.agentUnreadCount(normalized, rows, this);
  }

  otherAgentsHaveUnread(): boolean {
    return this.sessionProjection.otherAgentsHaveUnread(this);
  }
}
