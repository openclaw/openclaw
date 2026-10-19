import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { readPresenceEntries, type PresencePayload } from "../app/user-profile.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isGatewayAvailable } from "../lib/gateway-availability.ts";
import { projectPresencePayload } from "../lib/presence-users.ts";
import type { CatalogSessionContinuedDetail } from "../lib/sessions/catalog-key.ts";
import { childSessionListQuery } from "../lib/sessions/child-session-data.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  discardEmptyChildSessionSnapshot,
  applySidebarChildSessionSnapshot,
  finishSidebarChildSessionLoad,
  type SidebarChildSessionQuery,
  retireStaleChildSessionRows,
  scheduleSidebarChildSessions,
} from "./app-sidebar-child-session-data.ts";
import {
  SessionCatalogLiveState,
  sessionCatalogListClient,
} from "./app-sidebar-session-catalog-live.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";
import { createPanelRefreshStatus, type PanelRefreshStatus } from "./panel-refresh-status.ts";
import {
  applySessionCatalogContinuation,
  archiveSessionCatalog as archiveSessionCatalogData,
  importSessionCatalog as importSessionCatalogData,
  applySessionCatalogHostEvent as applySessionCatalogHostEventToData,
  invalidateSessionCatalogs as invalidateSessionCatalogData,
  loadMoreSessionCatalog as loadMoreSessionCatalogData,
  refreshSessionCatalogs as refreshSessionCatalogData,
  resetSessionCatalogConnection,
  retireSessionCatalogData,
  resolveSessionCatalogAgentId,
  scheduleSessionCatalogRefresh,
  type SessionCatalogDataOwner,
  type SessionDataInputs,
  updateSessionCatalogData,
} from "./session-data-catalog.ts";
import {
  hasSidebarListFilter,
  publishSidebarSessionError,
  publishSidebarSessionList,
  refreshSidebarSessionList,
  scheduleFilteredSidebarSessions,
  sidebarSessionListQuery,
  subscribeFilteredSidebarSessions,
  subscribeSidebarAgentSessionCaches,
  subscribeSessionDataGatewayEvents,
  subscribeSessionCatalogBrowserEvents,
} from "./session-data-events.ts";
import { SessionLineageOwner } from "./session-lineage.ts";
import { SidebarOwnerSessionCounts } from "./sidebar-owner-session-counts.ts";

/** Gateway-backed session-list and external-catalog data ownership. */
export class SessionDataOwner implements SessionCatalogDataOwner {
  sessionCatalogs: SessionCatalog[] = [];
  pendingCatalogArchives: ReadonlySet<string> = new Set();
  sessionCatalogRefreshStatus: PanelRefreshStatus = createPanelRefreshStatus();
  loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();
  visibleSessionLimits = new Map<string, number>();
  sessionsResult: SessionsListResult | null = null;
  sessionsAgentId: string | null = null;
  sessionsLoading = false;
  sessionsStartupPending = false;
  childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>> = {};
  loadedChildSessionKeys: ReadonlySet<string> = new Set();
  childSessionErrorsByParent: ReadonlyMap<string, string> = new Map();
  loadingChildSessionKeys: ReadonlySet<string> = new Set();
  activeSessionLineageRoot: GatewaySessionRow | null = null;
  activeSessionLineageSelectedRow: GatewaySessionRow | null = null;
  sessionMutationError: string | null = null;
  presencePayload: PresencePayload | undefined;
  presenceInstanceId?: string;
  readonly ownerCounts = new SidebarOwnerSessionCounts(() => this.requestSessionDataUpdate());

  sessionResultsByAgent: Record<string, SessionsListResult> = {};

  private stopSources: (() => void) | undefined;
  private stopRoster: (() => void) | undefined;
  private roster: ReturnType<typeof rosterActivityStore> | undefined;
  private renderFrame: number | undefined;
  private active = false;
  private presentationScope: readonly unknown[];
  readonly sessionCatalogLive = new SessionCatalogLiveState();
  sessionScopeGeneration = 0;
  sessionCatalogAgentId: string | null = null;
  sessionCatalogRevision = 0;
  readonly sessionCatalogPageDepths = new Map<string, number>();
  private sessionScopeAgentId: string | null = null;
  private agentSelectionSource: ApplicationContext["agentSelection"] | undefined;
  private agentSelectionIntentRevision: number | undefined;
  private sessionsSource: SessionCapability | null = null;
  private filteredSessionScope: string | null = null;
  private unsubscribeFilteredSessions: (() => void) | null = null;
  childSessionScope = {};
  private childSessionCanonicalListRevision: number | null = null;
  private readonly childSessionQueries = new Map<string, SidebarChildSessionQuery>();
  private gatewaySource: ApplicationContext["gateway"] | null = null;
  private gatewayConnectionRevision = 0;
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private gatewayAvailable = false;
  // Bind mutation completions to one epoch so stale failures cannot cross reconnects.
  private sessionMutationEpoch = 0;
  // Owns the abort signal handed to every epoch-scoped destructive confirm dialog.
  // Retiring the epoch aborts it so a dialog open across a reconnect dismisses
  // itself instead of confirming into a mutation scope that no longer applies.
  private sessionMutationAbortController = new AbortController();
  // Editable dialogs belong to the identity, not to a socket request epoch.
  private sessionDraftAbortController = new AbortController();
  private sessionDraftOwner: number | undefined;
  private sessionDraftAuth: { role?: string; scopes?: readonly string[] } | undefined;
  private readonly lineage = new SessionLineageOwner(
    this,
    () => ({ routeId: this.inputs.activeRouteId, key: this.inputs.getRouteSessionKey() }),
    () => this.childSessionScope,
  );

  constructor(
    private readonly inputs: SessionDataInputs,
    private readonly notify: () => void,
  ) {
    this.presentationScope = this.readPresentationScope();
  }

  private connectSources(): () => void {
    const { gateway, sessions, agents, agentSelection } = this.context;
    const onGateway = () => {
      this.synchronizeGateway(gateway);
      this.requestSessionDataUpdate();
    };
    const onSessions = () => {
      this.synchronizeSessions(sessions);
      this.requestSessionDataUpdate();
    };
    // State owners remain synchronous; only publication is coalesced to a frame.
    const stops = [gateway.subscribe(onGateway)];
    onGateway();
    stops.push(sessions.subscribe(onSessions));
    if (sessions !== this.sessionsSource) {
      onSessions();
    }
    stops.push(
      sessions.subscribeCreated((key) => this.inputs.promoteCreatedSession(key)),
      subscribeSessionDataGatewayEvents(gateway, this),
      subscribeSidebarAgentSessionCaches(agents, this, this.requestSessionDataUpdate),
      agentSelection.subscribe(() => this.synchronizeSessionScope()),
      subscribeSessionCatalogBrowserEvents((event) => {
        const { detail } = event as CustomEvent<CatalogSessionContinuedDetail>;
        applySessionCatalogContinuation(this, detail);
      }, this.handleSessionCatalogPageActivation),
    );
    this.synchronizeSessionScope();
    return () => stops.forEach((stop) => stop());
  }

  get context(): ApplicationContext {
    return this.inputs.sessionDataContext;
  }

  get isSessionDataHostConnected(): boolean {
    return this.inputs.isConnected;
  }

  get sessionLineageVisible(): boolean {
    return (
      this.inputs.navigationVisible &&
      this.inputs.navigationView === "sessions" &&
      !this.inputs.contextualSidebar
    );
  }

  get sessionsStartingUp(): boolean {
    return this.sessionsStartupPending || this.sessionCatalogLive.startupPending;
  }

  get sessionCatalogRowsVisible(): boolean {
    return this.inputs.sessionCatalogRowsVisible;
  }

  expandedAgentId = (): string => this.inputs.expandedAgentId();

  sessionCatalogIdsWithoutVisibleRows = (): readonly string[] =>
    this.inputs.sessionCatalogIdsWithoutVisibleRows();

  readonly requestSessionDataUpdate = () => {
    const roster = this.roster?.snapshot;
    if (roster) {
      publishSidebarSessionList(this, { ...roster, agentId: null });
    }
    if (!this.active || !this.inputs.navigationVisible || this.renderFrame !== undefined) {
      return;
    }
    const publish = () => {
      this.synchronizePresentedSessions();
      this.renderFrame = undefined;
      if (this.inputs.navigationVisible && this.inputs.shouldPublishSessionData()) {
        this.notify();
      }
    };
    if (document.visibilityState === "hidden" || typeof requestAnimationFrame !== "function") {
      publish();
    } else {
      this.renderFrame = requestAnimationFrame(publish);
    }
  };

  publishPresence(payload: unknown): void {
    const presence = readPresenceEntries(payload);
    const next = presence ? { presence } : undefined;
    const previous = this.presencePayload;
    this.presencePayload = next;
    this.synchronizeOwnerSessionCounts();
    if (!this.inputs.samePresence(previous, next)) {
      this.requestSessionDataUpdate();
    }
  }

  sessionListQuery = (agentId: string) => sidebarSessionListQuery(this.inputs, agentId);

  connect(): () => void {
    this.disconnect(true);
    // The Solid component owns one application context for this mount.
    this.stopSources = this.connectSources();
    this.active = true;
    this.synchronize();
    // Initial owner facets must settle before the first attached query observes them.
    this.synchronizePresentedSessions();
    if (this.inputs.navigationVisible && this.inputs.shouldPublishSessionData()) {
      this.notify();
    }
    return () => this.disconnect();
  }

  synchronize(): void {
    if (!this.active) {
      return;
    }
    const roster =
      this.inputs.sidebarAgentsMode === "roster" && this.sessionLineageVisible && this.context
        ? rosterActivityStore(this.context)
        : undefined;
    roster?.setInvolvingMe(this.inputs.sidebarSessionOwnerFilter().involvingMe);
    if (roster !== this.roster) {
      this.stopRoster?.();
      this.roster?.setInvolvingMe(false);
      this.roster = roster;
      this.stopRoster = roster?.subscribe(this.requestSessionDataUpdate);
      this.updateSessions(this.context.sessions);
      this.requestSessionDataUpdate();
      void this.scheduleSidebarSessions();
    }
    this.lineage.synchronize();
    const scope = this.readPresentationScope();
    if (scope.some((value, index) => value !== this.presentationScope[index])) {
      this.presentationScope = scope;
      // A changed presentation scope admits current facts before its rows render.
      this.inputs.shouldPublishSessionData();
    }
  }

  private readPresentationScope(): readonly unknown[] {
    return [
      this.inputs.navigationVisible,
      this.inputs.navigationView,
      Boolean(this.inputs.contextualSidebar),
      this.inputs.sidebarAgentsMode,
      this.inputs.connected,
      this.filteredSessionScope,
    ];
  }

  refreshPresentation(): void {
    if (this.active && this.inputs.isConnected) {
      this.synchronizeSessionScope();
      this.synchronizeOwnerSessionCounts();
      this.lineage.synchronize();
      this.synchronizePresentedSessions();
    }
  }

  private synchronizePresentedSessions(): void {
    updateSessionCatalogData(this);
    if (!this.sessionLineageVisible) {
      return;
    }
    // Discovery can advance without changing displayed rows; admit it before the frame gate.
    if (isSessionRouteId(this.inputs.activeRouteId)) {
      void this.loadActiveSessionLineage(this.inputs.getRouteSessionKey());
    }
    scheduleSidebarChildSessions(this, () => this.inputs.childSessionParents());
  }

  disconnect(retainOwner = false): void {
    this.active = false;
    if (this.renderFrame !== undefined) {
      cancelAnimationFrame(this.renderFrame);
      this.renderFrame = undefined;
    }
    this.stopSources?.();
    this.stopSources = undefined;
    this.stopRoster?.();
    this.stopRoster = undefined;
    this.roster?.setInvolvingMe(false);
    this.roster = undefined;
    // A provider replacement releases the view while retaining its sidebar owner.
    if (retainOwner) {
      return;
    }
    this.ownerCounts.dispose();
    this.resetChildSessionState();
    this.retireFilteredSessions();
    this.sessionsSource = null;
    this.inputs.dismissTransientMenus();
    this.invalidateSessionMutations();
    this.retireSessionDrafts();
    this.sessionDraftAuth = undefined;
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.gatewayAvailable = false;
    this.agentSelectionSource = undefined;
    this.agentSelectionIntentRevision = undefined;
    retireSessionCatalogData(this);
    this.lineage.disconnect();
  }

  sessionCatalogGatewayClient(): GatewayBrowserClient | null {
    return sessionCatalogListClient(this.context?.gateway.snapshot, this.inputs.connected);
  }

  private synchronizeOwnerSessionCounts(): void {
    const hasProfiles = projectPresencePayload(this.presencePayload).users.some(
      (user) => user.identity?.type === "profile",
    );
    this.ownerCounts.synchronize(
      this.inputs.connected && hasProfiles ? this.context?.sessions : undefined,
      this.context?.gateway.snapshot.selfUser?.id ?? null,
      this.context?.connectionBootstrap,
    );
  }

  synchronizeSessionScope(): void {
    const context = this.context;
    const selection = context?.agentSelection;
    const foreground =
      selection !== undefined &&
      selection === this.agentSelectionSource &&
      selection.intentRevision !== this.agentSelectionIntentRevision;
    // Consume same-agent intent too, before a later automatic scope change can reuse it.
    this.agentSelectionSource = selection;
    this.agentSelectionIntentRevision = selection?.intentRevision;
    const nextAgentId = context ? normalizeAgentId(this.inputs.expandedAgentId()) : null;
    // A reconnect cannot revoke ownership until its replacement hello is authoritative.
    const nextCatalogAgentId =
      resolveSessionCatalogAgentId(this) ??
      (context?.gateway.snapshot.phase !== "connected" ? this.sessionCatalogAgentId : null);
    if (
      nextAgentId === this.sessionScopeAgentId &&
      nextCatalogAgentId === this.sessionCatalogAgentId
    ) {
      return;
    }

    const previousAgentId = this.sessionScopeAgentId;
    const previousCatalogAgentId = this.sessionCatalogAgentId;
    const agentChanged =
      previousAgentId !== null &&
      previousAgentId !== nextAgentId &&
      this.sessionListQuery(this.inputs.expandedAgentId()).agentId !== undefined;
    const catalogAgentChanged =
      previousCatalogAgentId !== null && previousCatalogAgentId !== nextCatalogAgentId;
    const ownsCurrentCanonicalList =
      !hasSidebarListFilter(this.inputs) &&
      nextAgentId !== null &&
      this.sessionsAgentId !== null &&
      normalizeAgentId(this.sessionsAgentId) === nextAgentId &&
      this.sessionsResult === context?.sessions.presentation.result;

    this.sessionScopeAgentId = nextAgentId;
    this.sessionCatalogAgentId = nextCatalogAgentId;
    retireSessionCatalogData(this);
    this.sessionCatalogRevision += 1;
    this.sessionCatalogRefreshStatus = createPanelRefreshStatus();

    if (agentChanged || catalogAgentChanged) {
      // Catalog cursors and rows belong to the selected agent, not just its host.
      this.sessionCatalogs = [];
      this.sessionCatalogPageDepths.clear();
    }
    if (agentChanged && !ownsCurrentCanonicalList) {
      // A replacement capability may publish its new-agent list before selection synchronizes.
      this.clearSessionCache();
    }
    this.bindFilteredSessions();
    this.requestSessionDataUpdate();

    if (
      agentChanged &&
      this.inputs.sidebarAgentsMode !== "roster" &&
      context?.gateway.snapshot.phase === "connected" &&
      hasSidebarListFilter(this.inputs)
    ) {
      void (foreground ? this.refreshSidebarSessions() : this.scheduleSidebarSessions());
    }
  }

  handleSessionCatalogHostEvent = applySessionCatalogHostEventToData.bind(null, this);

  private readonly handleSessionCatalogPageActivation = () => scheduleSessionCatalogRefresh(this);

  invalidateSessionCatalogs = invalidateSessionCatalogData.bind(null, this);

  archiveSessionCatalog = archiveSessionCatalogData.bind(null, this);

  importSessionCatalog = importSessionCatalogData.bind(null, this);

  refreshSessionCatalogs = (): Promise<void> => refreshSessionCatalogData(this);

  loadMoreSessionCatalog = (catalogId: string): Promise<void> =>
    loadMoreSessionCatalogData(this, catalogId);

  private resetChildSessionState(preserveOperatorContext = false): void {
    for (const query of this.childSessionQueries.values()) {
      query.observation?.dispose();
    }
    this.childSessionQueries.clear();
    this.childSessionScope = {};
    this.loadedChildSessionKeys = new Set();
    this.loadingChildSessionKeys = new Set();
    this.childSessionErrorsByParent = new Map();
    if (!preserveOperatorContext) {
      this.childSessionRowsByParent = {};
      this.activeSessionLineageRoot = null;
      this.activeSessionLineageSelectedRow = null;
    }
    this.lineage.reset(preserveOperatorContext);
  }

  private readonly updateSessions = (sessions: SessionCapability) => {
    const snapshot = sessions.state;
    if (sessions.presentation.resultCached) {
      return;
    }
    if (this.childSessionCanonicalListRevision !== sessions.canonicalListRevision) {
      this.childSessionCanonicalListRevision = sessions.canonicalListRevision;
      // Observed child queries own their freshness. Only unobserved, collapsed
      // snapshots lose their presentation lease when the canonical list refreshes.
      this.loadedChildSessionKeys = new Set(
        [...this.loadedChildSessionKeys].filter((key) => this.childSessionQueries.has(key)),
      );
      this.lineage.reset(true);
      this.requestSessionDataUpdate();
    }
    if (this.roster || hasSidebarListFilter(this.inputs)) {
      return;
    }
    const presentation = sessions.presentation;
    if (!sessions.presentation.result && this.sessionsResult) {
      this.clearSessionCache();
    }
    publishSidebarSessionList(this, { ...snapshot, ...presentation });
    this.requestSessionDataUpdate();
  };

  private synchronizeSessions(sessions: SessionCapability): void {
    const sourceChanged = sessions !== this.sessionsSource;
    if (sourceChanged) {
      this.invalidateSessionMutations();
      this.retireSessionDrafts();
      this.retireFilteredSessions();
      this.clearSessionCache();
      this.sessionsSource = sessions;
    }
    this.updateSessions(sessions);
    if (this.context?.gateway.snapshot.phase === "connected") {
      if (sourceChanged && hasSidebarListFilter(this.inputs)) {
        void this.scheduleSidebarSessions();
      }
      void this.context.connectionBootstrap.run(sessions.groupsLoad, sessions.groupsLoad, {
        background: true,
      });
    }
  }

  private synchronizeGateway(gateway: ApplicationContext["gateway"]): void {
    this.lineage.synchronize();
    const draftOwner = gatewayPresentationScope(gateway).key;
    const auth = gateway.snapshot.phase === "connected" ? gateway.snapshot.hello?.auth : undefined;
    if (
      (this.sessionDraftOwner !== undefined && this.sessionDraftOwner !== draftOwner) ||
      (auth &&
        auth !== this.sessionDraftAuth &&
        this.sessionDraftAuth?.scopes &&
        !roleScopesAllow({
          role: auth.role ?? "operator",
          requestedScopes: this.sessionDraftAuth.scopes,
          allowedScopes: auth.scopes ?? [],
        }))
    ) {
      this.retireSessionDrafts();
    }
    this.sessionDraftOwner = draftOwner;
    if (auth) {
      this.sessionDraftAuth = auth;
    }
    const client = gateway.snapshot.client;
    const connected = gateway.snapshot.phase === "connected";
    const sessionSourceChanged =
      gateway !== this.gatewaySource ||
      gateway.connectionRevision !== this.gatewayConnectionRevision;
    const clientChanged = client !== this.gatewayClient;
    const sourceOrClientChanged = sessionSourceChanged || clientChanged;
    const connectionChanged = connected !== this.gatewayConnected;
    const available = isGatewayAvailable(gateway.snapshot);
    const becameAvailable = available && !this.gatewayAvailable;
    this.gatewayAvailable = available;
    // Presence updates preserve in-flight pages, but a new authority projection
    // can revoke catalog ownership without replacing the socket client.
    if (!sourceOrClientChanged && !connectionChanged) {
      this.synchronizeSessionScope();
      this.synchronizeOwnerSessionCounts();
      const { awaitingGateway, error } = this.sessionCatalogRefreshStatus;
      const requesting = this.sessionCatalogLive.requestGeneration !== null;
      if (becameAvailable && (awaitingGateway || error !== null || requesting)) {
        scheduleSessionCatalogRefresh(this);
      }
      return;
    }
    this.invalidateSessionMutations();
    if (sourceOrClientChanged) {
      this.retireSessionDrafts();
    }
    this.ownerCounts.dispose();
    this.resetChildSessionState(true);
    this.gatewaySource = gateway;
    this.gatewayConnectionRevision = gateway.connectionRevision;
    this.gatewayClient = client;
    this.gatewayConnected = connected;
    this.presenceInstanceId = client?.instanceId;
    if (!connected) {
      this.presencePayload = undefined;
    } else if (clientChanged || connectionChanged) {
      const presence = readPresenceEntries(gateway.snapshot.hello?.snapshot);
      this.presencePayload = presence ? { presence } : undefined;
    }
    this.requestSessionDataUpdate();
    if (sourceOrClientChanged) {
      // Session rows belong to the logical Gateway, not one replaceable socket client.
      if (sessionSourceChanged) {
        this.clearSessionCache();
      }
      resetSessionCatalogConnection(this);
    } else {
      retireSessionCatalogData(this);
    }
    if (connected && this.sessionsSource && hasSidebarListFilter(this.inputs)) {
      void this.scheduleSidebarSessions();
    }
  }

  private clearSessionCache(): void {
    this.childSessionCanonicalListRevision = null;
    this.sessionsResult = null;
    this.sessionsAgentId = null;
    this.sessionsStartupPending = false;
    this.sessionResultsByAgent = {};
    this.resetChildSessionState();
    this.visibleSessionLimits = new Map();
    this.requestSessionDataUpdate();
  }

  private retireFilteredSessions(): void {
    this.unsubscribeFilteredSessions?.();
    this.unsubscribeFilteredSessions = null;
    this.filteredSessionScope = null;
  }

  private bindFilteredSessions(): void {
    const sessions = this.context?.sessions;
    if (
      !sessions ||
      this.inputs.sidebarAgentsMode === "roster" ||
      !hasSidebarListFilter(this.inputs)
    ) {
      this.retireFilteredSessions();
      return;
    }
    const normalizedAgentId = normalizeAgentId(this.inputs.expandedAgentId());
    const query = this.sessionListQuery(normalizedAgentId);
    const scopeKey = JSON.stringify(query);
    if (this.filteredSessionScope === scopeKey) {
      return;
    }
    this.retireFilteredSessions();
    this.filteredSessionScope = scopeKey;
    this.unsubscribeFilteredSessions = subscribeFilteredSidebarSessions(
      this,
      sessions,
      query,
      () =>
        this.filteredSessionScope === scopeKey &&
        this.context?.sessions === sessions &&
        this.inputs.sidebarSessionStatusFilter() === query.archivedFilter &&
        this.sessionListQuery(this.inputs.expandedAgentId()).agentId === query.agentId,
    );
  }

  refreshSidebarSessions(affectedAgentId?: string): Promise<void> {
    if (this.inputs.sidebarAgentsMode === "roster") {
      return rosterActivityStore(this.context).refresh();
    }
    this.bindFilteredSessions();
    return refreshSidebarSessionList(this, { affectedAgentId });
  }

  scheduleSidebarSessions(): Promise<void> {
    this.bindFilteredSessions();
    return scheduleFilteredSidebarSessions(this, () => this.unsubscribeFilteredSessions);
  }

  loadMoreSidebarSessions(): Promise<void> {
    return refreshSidebarSessionList(this, { agentId: this.sessionsAgentId, append: true });
  }

  retireStaleChildSessions(revalidating: ReadonlySet<string>): void {
    for (const [key, query] of this.childSessionQueries) {
      if (!revalidating.has(key) && !query.refresh && !query.hydration) {
        query.observation?.dispose();
        this.childSessionQueries.delete(key);
        this.finishChildSessionLoad(key);
      }
    }
    retireStaleChildSessionRows(this, this.lineage.routeKey, revalidating);
  }

  needsChildSessionLoad(parentKey: string): boolean {
    return (
      !this.childSessionQueries.has(parentKey) && !this.childSessionErrorsByParent.has(parentKey)
    );
  }

  async loadChildSessions(parentKey: string, retry = false): Promise<void> {
    const sessions = this.context?.sessions;
    if (
      !this.inputs.isConnected ||
      !sessions ||
      !sessions.captureConnectionScope() ||
      !parentKey ||
      this.childSessionErrorsByParent.has(parentKey)
    ) {
      return;
    }
    const existing = this.childSessionQueries.get(parentKey);
    if (existing) {
      await existing.refresh;
      await existing.hydration;
      return;
    }
    const scope = { ...childSessionListQuery(parentKey), source: "sidebar" as const };
    const query: SidebarChildSessionQuery = {};
    this.childSessionQueries.set(parentKey, query);
    const isCurrent = () =>
      this.inputs.isConnected &&
      sessions === this.context?.sessions &&
      this.childSessionQueries.get(parentKey) === query;
    query.observation = sessions.observeList(
      scope,
      applySidebarChildSessionSnapshot.bind(null, {
        owner: this,
        sessions,
        parentKey,
        query,
        retry,
        isCurrent,
        captureChildRead: () => this.lineage.captureChildRead(scope),
        selectedKey: () => this.lineage.routeKey,
        finishLoad: () => this.finishChildSessionLoad(parentKey),
      }),
    );
    if (!isCurrent()) {
      query.observation.dispose();
      return;
    }
    query.refresh = query.observation
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        query.refresh = undefined;
        if (isCurrent()) {
          this.requestSessionDataUpdate();
        }
      });
    await query.refresh;
    await query.hydration;
  }

  private readonly finishChildSessionLoad = finishSidebarChildSessionLoad.bind(
    null,
    this,
    (parentKey: string) => {
      this.childSessionQueries.get(parentKey)?.observation?.dispose();
      this.childSessionQueries.delete(parentKey);
    },
  );

  loadActiveSessionLineage = this.lineage.load.bind(this.lineage);

  setVisibleSessionLimit(sectionId: string, limit: number): void {
    this.visibleSessionLimits = new Map(this.visibleSessionLimits).set(sectionId, limit);
    this.requestSessionDataUpdate();
  }

  dismissSessionMutationError(): void {
    publishSidebarSessionError(this, null, "action");
    this.requestSessionDataUpdate();
  }

  resetSessionList(): void {
    this.retireFilteredSessions();
    this.sessionsLoading = false;
    this.visibleSessionLimits = new Map();
    // A filter transition owns a new child/lineage generation; otherwise a
    // pending request from the retired view can repopulate its cleared rows.
    this.resetChildSessionState();
    this.sessionResultsByAgent = {};
    if (!hasSidebarListFilter(this.inputs) && this.context) {
      const presentation = this.context.sessions.presentation;
      this.sessionsResult = presentation.resultCached ? null : presentation.result;
      this.sessionsAgentId = presentation.resultCached ? null : presentation.agentId;
    } else if (this.context) {
      this.bindFilteredSessions();
    }
    this.requestSessionDataUpdate();
  }

  discardEmptyChildSessionSnapshot = discardEmptyChildSessionSnapshot.bind(null, this);

  retryChildSessions(sessionKey: string): void {
    const retry = this.childSessionErrorsByParent.has(sessionKey);
    if (retry) {
      this.finishChildSessionLoad(sessionKey);
      const errors = new Map(this.childSessionErrorsByParent);
      errors.delete(sessionKey);
      this.childSessionErrorsByParent = errors;
    }
    void this.loadChildSessions(sessionKey, retry);
  }

  private invalidateSessionMutations(): void {
    this.sessionMutationEpoch += 1;
    publishSidebarSessionError(this, null, "action");
    // Dismiss any confirm dialog still open under the retired epoch before a
    // new one can be issued; otherwise it stays modal until manually closed.
    this.sessionMutationAbortController.abort();
    this.sessionMutationAbortController = new AbortController();
    this.requestSessionDataUpdate();
  }

  get sessionDraftSignal(): AbortSignal {
    return this.sessionDraftAbortController.signal;
  }

  private retireSessionDrafts(): void {
    this.sessionDraftAbortController.abort();
    this.sessionDraftAbortController = new AbortController();
  }

  beginSessionMutation(): SidebarSessionMutationScope | null {
    const context = this.context;
    if (!context || !this.inputs.connected) {
      return null;
    }
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    this.dismissSessionMutationError();
    return {
      epoch: this.sessionMutationEpoch,
      context,
      gateway,
      sessions: context.sessions,
      client,
      selectedAgentId: this.inputs.selectedAgentIdForSessions(),
      signal: this.sessionMutationAbortController.signal,
    };
  }

  isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean {
    const context = this.context;
    const gateway = context?.gateway;
    return (
      this.inputs.connected &&
      this.sessionMutationEpoch === scope.epoch &&
      context === scope.context &&
      gateway === scope.gateway &&
      context.sessions === scope.sessions &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === scope.client
    );
  }

  publishSessionMutationError(scope: SidebarSessionMutationScope, error: unknown): void {
    if (this.isSessionMutationScopeCurrent(scope)) {
      publishSidebarSessionError(this, formatUiError(error), "action");
      this.requestSessionDataUpdate();
    }
  }
}
