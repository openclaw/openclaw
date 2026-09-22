import type { ReactiveController } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../app/user-profile.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isGatewayAvailable } from "../lib/gateway-availability.ts";
import type { CatalogSessionContinuedDetail } from "../lib/sessions/catalog-key.ts";
import { childSessionListQuery } from "../lib/sessions/child-session-data.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  hydrateSidebarChildSessions,
  retireStaleChildSessionRows,
} from "./app-sidebar-child-session-data.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import type {
  SidebarSessionMutationScope,
  SidebarSessionsScrollState,
} from "./app-sidebar-session-types.ts";
import { createPanelRefreshStatus, type PanelRefreshStatus } from "./panel-refresh-status.ts";
import {
  applySessionCatalogContinuation,
  archiveSessionCatalog as archiveSessionCatalogData,
  applySessionCatalogHostEvent as applySessionCatalogHostEventToData,
  applySessionCatalogChanged as applySessionCatalogChangedToData,
  invalidateSessionCatalogs as invalidateSessionCatalogData,
  loadMoreSessionCatalog as loadMoreSessionCatalogData,
  refreshSessionCatalogs as refreshSessionCatalogData,
  resolveSessionCatalogAgentId,
  scheduleSessionCatalogRefresh,
  type SessionCatalogDataOwner,
  type SessionDataControllerHost,
  updateSessionCatalogData,
} from "./session-data-controller-catalog.ts";
import {
  hasSidebarListFilter,
  publishSidebarSessionError,
  publishSidebarSessionList,
  refreshSidebarSessionList,
  scheduleFilteredSidebarSessions,
  sidebarSessionListQuery,
  subscribeSidebarAgentSessionCaches,
  subscribeFilteredSidebarSessions,
  subscribeSessionDataGatewayEvents,
  subscribeSessionCatalogBrowserEvents,
} from "./session-data-controller-events.ts";
import { SessionDataScrollController } from "./session-data-scroll-controller.ts";
import { SessionLineageController } from "./session-lineage-controller.ts";

type ChildSessionQuery = {
  observation?: ReturnType<SessionCapability["observeList"]>;
  result?: SessionsListResult;
  loading?: boolean;
  childRead?: ReturnType<SessionLineageController["captureChildRead"]>;
  hydration?: Promise<void>;
  refresh?: Promise<void>;
};

/** Gateway-backed session-list and external-catalog data ownership. */
export class SessionDataController implements ReactiveController, SessionCatalogDataOwner {
  sessionCatalogs: SessionCatalog[] = [];
  readonly pendingCatalogArchives = new Set<string>();
  sessionCatalogRefreshStatus: PanelRefreshStatus = createPanelRefreshStatus();
  loadingMoreSessionCatalogIds: ReadonlySet<string> = new Set();
  visibleSessionLimits = new Map<string, number>();
  sessionsResult: SessionsListResult | null = null;
  sessionsAgentId: string | null = null;
  sessionsLoading = false;
  childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>> = {};
  loadedChildSessionKeys: ReadonlySet<string> = new Set();
  childSessionErrorsByParent: ReadonlyMap<string, string> = new Map();
  loadingChildSessionKeys: ReadonlySet<string> = new Set();
  activeSessionLineageRoot: GatewaySessionRow | null = null;
  activeSessionLineageSelectedRow: GatewaySessionRow | null = null;
  sessionMutationError: string | null = null;
  presencePayload: PresencePayload | undefined;
  presenceInstanceId?: string;

  // These caches were not Lit state on the element and stay non-reactive here.
  sessionResultsByAgent: Record<string, SessionsListResult> = {};

  private readonly subscriptions: SubscriptionsController;
  readonly sessionCatalogLive = new SessionCatalogLiveState();
  sessionScopeGeneration = 0;
  sessionCatalogAgentId: string | null = null;
  sessionCatalogRevision = 0;
  readonly sessionCatalogPageDepths = new Map<string, number>();
  readonly sessionCatalogRevisions = new Map<string, number>();
  private sessionScopeAgentId: string | null = null;
  private sessionsSource: SessionCapability | null = null;
  private filteredSessionScope: string | null = null;
  private unsubscribeFilteredSessions: (() => void) | null = null;
  childSessionScope = {};
  private childSessionCanonicalListRevision: number | null = null;
  private readonly childSessionQueries = new Map<string, ChildSessionQuery>();
  private cachedSessionResult: SessionsListResult | null = null;
  private stopCatalogBrowserEvents: (() => void) | null = null;
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
  private readonly scroll = new SessionDataScrollController(() => this.requestSessionDataUpdate());
  private readonly lineage = new SessionLineageController(
    this,
    () => ({ routeId: this.host.activeRouteId, key: this.host.getRouteSessionKey() }),
    () => this.childSessionScope,
  );

  constructor(private readonly host: SessionDataControllerHost) {
    host.addController(this);
    // The element used to enter subscriptions before connecting catalog listeners,
    // then tear subscriptions down after all session cleanup. Keep that ordering.
    this.subscriptions = new SubscriptionsController({
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => host.requestUpdate(),
      get updateComplete() {
        return host.updateComplete;
      },
    });
    this.subscriptions
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
        (gateway) => this.synchronizeGateway(gateway),
      )
      .watch(
        () => this.context?.sessions,
        (sessions, notify) => sessions.subscribe(notify),
        (sessions) => this.synchronizeSessions(sessions),
      )
      .effect(
        () => this.context?.sessions,
        (sessions) => sessions.subscribeCreated((key) => host.promoteCreatedSession(key)),
      )
      .effect(
        () => this.context?.gateway,
        (gateway) => subscribeSessionDataGatewayEvents(gateway, this),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => subscribeSidebarAgentSessionCaches(agents, this, notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (agentSelection, notify) => agentSelection.subscribe(notify),
        () => this.synchronizeSessionScope(),
      );
  }

  get context(): ApplicationContext | undefined {
    return this.host.sessionDataContext;
  }

  get isSessionDataHostConnected(): boolean {
    return this.host.isConnected;
  }

  get sessionDataHostConnected(): boolean {
    return this.host.connected;
  }

  expandedAgentId = (): string => this.host.expandedAgentId();

  sessionCatalogIdsWithoutVisibleRows = (): readonly string[] =>
    this.host.sessionCatalogIdsWithoutVisibleRows();

  readonly requestSessionDataUpdate = () => this.host.requestUpdate();

  sessionListQuery = (agentId: string) => sidebarSessionListQuery(this.host, agentId);

  hostConnected(): void {
    this.subscriptions.hostConnected();
    this.stopCatalogBrowserEvents = subscribeSessionCatalogBrowserEvents(
      this.handleCatalogSessionContinued as EventListener,
      this.handleSessionCatalogPageActivation,
    );
  }

  hostUpdate(): void {
    this.subscriptions.hostUpdate();
    this.lineage.synchronize();
  }

  hostUpdated(): void {
    // Lit can finish a queued update after disconnect. Keep retired timers and
    // observers closed until the host reconnects.
    if (this.host.isConnected) {
      this.synchronizeSessionScope();
      this.lineage.synchronize();
      this.scroll.synchronize(this.host);
      updateSessionCatalogData(this);
    }
  }

  hostDisconnected(): void {
    this.resetChildSessionState();
    this.retireFilteredSessions();
    this.stopCatalogBrowserEvents?.();
    this.stopCatalogBrowserEvents = null;
    this.host.dismissTransientMenus();
    this.invalidateSessionMutations();
    this.gatewaySource = null;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.gatewayAvailable = false;
    this.retireSessionCatalogData();
    this.scroll.dispose();
    this.lineage.disconnect();
    this.subscriptions.hostDisconnected();
  }

  sessionCatalogGatewayClient(): GatewayBrowserClient | null {
    return this.gatewayClient;
  }

  retireSessionCatalogData(): void {
    this.sessionScopeGeneration += 1;
    this.pendingCatalogArchives.clear();
    this.sessionsLoading = false;
    this.loadingMoreSessionCatalogIds = new Set();
    this.sessionCatalogLive.clear();
  }

  resetSessionCatalogConnection(): void {
    this.retireSessionCatalogData();
    this.sessionCatalogRevision += 1;
    this.sessionCatalogs = [];
    this.sessionCatalogRefreshStatus = createPanelRefreshStatus();
    this.sessionCatalogPageDepths.clear();
    this.sessionCatalogRevisions.clear();
    this.requestSessionDataUpdate();
  }

  synchronizeSessionScope(): void {
    const context = this.context;
    const nextAgentId = context ? normalizeAgentId(this.host.expandedAgentId()) : null;
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
    const agentChanged = previousAgentId !== null && previousAgentId !== nextAgentId;
    const catalogAgentChanged =
      previousCatalogAgentId !== null && previousCatalogAgentId !== nextCatalogAgentId;
    const ownsCurrentCanonicalList =
      !hasSidebarListFilter(this.host) &&
      nextAgentId !== null &&
      this.sessionsAgentId !== null &&
      normalizeAgentId(this.sessionsAgentId) === nextAgentId &&
      this.sessionsResult === context?.sessions.presentation.result;

    this.sessionScopeAgentId = nextAgentId;
    this.sessionCatalogAgentId = nextCatalogAgentId;
    this.retireSessionCatalogData();
    this.sessionCatalogRevision += 1;
    this.sessionCatalogRefreshStatus = createPanelRefreshStatus();

    if (agentChanged || catalogAgentChanged) {
      // Catalog cursors and rows belong to the selected agent, not just its host.
      this.sessionCatalogs = [];
      this.sessionCatalogPageDepths.clear();
      this.sessionCatalogRevisions.clear();
    }
    if (agentChanged && !ownsCurrentCanonicalList) {
      // A replacement capability may publish its new-agent list before selection synchronizes.
      this.clearSessionCache();
    }
    this.bindFilteredSessions();
    this.requestSessionDataUpdate();

    if (
      agentChanged &&
      context?.gateway.snapshot.phase === "connected" &&
      hasSidebarListFilter(this.host)
    ) {
      void this.scheduleSidebarSessions();
    }
  }

  handleSessionCatalogHostEvent(payload: unknown): void {
    applySessionCatalogHostEventToData(this, payload);
  }

  handleSessionCatalogChanged(payload: unknown): void {
    applySessionCatalogChangedToData(this, payload);
  }

  private readonly handleCatalogSessionContinued = (
    event: CustomEvent<CatalogSessionContinuedDetail>,
  ) => {
    applySessionCatalogContinuation(this, event.detail);
  };

  private readonly handleSessionCatalogPageActivation = () => {
    scheduleSessionCatalogRefresh(this);
  };

  invalidateSessionCatalogs = () => invalidateSessionCatalogData(this);

  archiveSessionCatalog = archiveSessionCatalogData.bind(null, this);

  refreshSessionCatalogs = (): Promise<void> => refreshSessionCatalogData(this);

  loadMoreSessionCatalog = (catalogId: string): Promise<void> =>
    loadMoreSessionCatalogData(this, catalogId);

  get sessionsScrollState(): SidebarSessionsScrollState {
    return this.scroll.state;
  }

  updateSessionsScrollState(element: HTMLElement): void {
    this.scroll.update(element);
  }

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
    if (this.cachedSessionResult && !sessions.presentation.resultCached) {
      // A filtered live list can replace the cached projection before the primary list lands.
      if (this.sessionsResult === this.cachedSessionResult) {
        this.clearSessionCache();
      }
      this.cachedSessionResult = null;
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
    if (hasSidebarListFilter(this.host)) {
      return;
    }
    if (!sessions.presentation.result && this.sessionsResult) {
      this.clearSessionCache();
    }
    publishSidebarSessionList(this, { ...snapshot, ...sessions.presentation });
    this.cachedSessionResult = sessions.presentation.resultCached
      ? sessions.presentation.result
      : null;
    this.sessionsLoading = snapshot.loading;
    this.requestSessionDataUpdate();
  };

  private synchronizeSessions(sessions: SessionCapability): void {
    const sourceChanged = sessions !== this.sessionsSource;
    if (sourceChanged) {
      this.invalidateSessionMutations();
      this.retireFilteredSessions();
      this.clearSessionCache();
      this.sessionsSource = sessions;
    }
    this.updateSessions(sessions);
    if (this.context?.gateway.snapshot.phase === "connected") {
      void this.context.connectionBootstrap.run(sessions.groupsLoad, () => sessions.groupsLoad(), {
        background: true,
      });
      if (sourceChanged && hasSidebarListFilter(this.host)) {
        void this.scheduleSidebarSessions();
      }
    }
  }

  private synchronizeGateway(gateway: ApplicationContext["gateway"]): void {
    this.lineage.synchronize();
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
    // Presence and auth snapshots must not retire this client's in-flight
    // native or catalog pages unless its connection phase actually changes.
    if (!sourceOrClientChanged && !connectionChanged) {
      const { awaitingGateway, error } = this.sessionCatalogRefreshStatus;
      const requesting = this.sessionCatalogLive.requestGeneration !== null;
      if (becameAvailable && (awaitingGateway || error !== null || requesting)) {
        scheduleSessionCatalogRefresh(this);
      }
      return;
    }
    this.invalidateSessionMutations();
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
      this.resetSessionCatalogConnection();
    } else {
      this.retireSessionCatalogData();
    }
    if (connected && this.sessionsSource && hasSidebarListFilter(this.host)) {
      void this.scheduleSidebarSessions();
    }
  }

  private clearSessionCache(): void {
    this.childSessionCanonicalListRevision = null;
    this.cachedSessionResult = null;
    this.sessionsResult = null;
    this.sessionsAgentId = null;
    this.sessionResultsByAgent = {};
    this.resetChildSessionState();
    this.visibleSessionLimits.clear();
    this.requestSessionDataUpdate();
  }

  private retireFilteredSessions(): void {
    this.unsubscribeFilteredSessions?.();
    this.unsubscribeFilteredSessions = null;
    this.filteredSessionScope = null;
  }

  private bindFilteredSessions(): void {
    const sessions = this.context?.sessions;
    if (!sessions || !hasSidebarListFilter(this.host)) {
      this.retireFilteredSessions();
      return;
    }
    const normalizedAgentId = normalizeAgentId(this.host.expandedAgentId());
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
        this.host.sidebarSessionStatusFilter() === query.archivedFilter &&
        normalizeAgentId(this.host.expandedAgentId()) === normalizedAgentId,
    );
  }

  refreshSidebarSessions(affectedAgentId?: string): Promise<void> {
    const agentId = this.host.expandedAgentId();
    this.bindFilteredSessions();
    if (
      affectedAgentId !== undefined &&
      normalizeAgentId(affectedAgentId) !== normalizeAgentId(agentId)
    ) {
      return Promise.resolve();
    }
    return refreshSidebarSessionList(this, agentId);
  }

  scheduleSidebarSessions(): Promise<void> {
    this.bindFilteredSessions();
    return scheduleFilteredSidebarSessions(this, () => this.unsubscribeFilteredSessions);
  }

  loadMoreSidebarSessions(): Promise<void> {
    return refreshSidebarSessionList(this, this.sessionsAgentId, true);
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
      !this.host.isConnected ||
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
    const scope = childSessionListQuery(parentKey);
    const query: ChildSessionQuery = {};
    this.childSessionQueries.set(parentKey, query);
    const isCurrent = () =>
      this.host.isConnected &&
      sessions === this.context?.sessions &&
      this.childSessionQueries.get(parentKey) === query;
    query.observation = sessions.observeList(scope, (snapshot) => {
      if (!isCurrent()) {
        return;
      }
      if (snapshot.loading) {
        if (!query.loading) {
          query.childRead = this.lineage.captureChildRead(scope);
        }
        query.loading = true;
        this.loadingChildSessionKeys = new Set([...this.loadingChildSessionKeys, parentKey]);
        this.requestSessionDataUpdate();
        return;
      }
      if (snapshot.error) {
        if (retry && !query.observation) {
          return;
        }
        query.loading = false;
        this.childSessionErrorsByParent = new Map(this.childSessionErrorsByParent).set(
          parentKey,
          snapshot.error,
        );
        this.finishChildSessionLoad(parentKey);
        return;
      }
      const result = snapshot.result;
      const refreshed = query.loading || !query.result;
      query.loading = false;
      if (!result) {
        return;
      }
      if (!refreshed) {
        // A sibling observation can update held row fields without a new page.
        // Project those facts without restarting pagination or read admission.
        const rows = this.childSessionRowsByParent[parentKey];
        if (rows) {
          const current = sessions.projectRows(rows);
          if (current.some((row, index) => row !== rows[index])) {
            this.childSessionRowsByParent = {
              ...this.childSessionRowsByParent,
              [parentKey]: current,
            };
            this.requestSessionDataUpdate();
          }
        }
        return;
      }
      query.result = result;
      if (query.hydration) {
        return;
      }
      query.hydration = hydrateSidebarChildSessions({
        owner: this,
        parentKey,
        sessions,
        initialResult: result,
        childRead: query.childRead ?? this.lineage.captureChildRead(scope),
        ownsQuery: isCurrent,
        selectedKey: () => this.lineage.routeKey,
      }).finally(() => {
        if (isCurrent()) {
          query.hydration = undefined;
          this.finishChildSessionLoad(parentKey);
        }
      });
    });
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

  private finishChildSessionLoad(parentKey: string): void {
    if (this.childSessionErrorsByParent.has(parentKey)) {
      const loaded = new Set(this.loadedChildSessionKeys);
      loaded.delete(parentKey);
      this.loadedChildSessionKeys = loaded;
      this.childSessionQueries.get(parentKey)?.observation?.dispose();
      this.childSessionQueries.delete(parentKey);
    }
    const next = new Set(this.loadingChildSessionKeys);
    next.delete(parentKey);
    this.loadingChildSessionKeys = next;
    this.requestSessionDataUpdate();
  }

  loadActiveSessionLineage(sessionKey: string): Promise<void> {
    return this.lineage.load(sessionKey);
  }

  setVisibleSessionLimit(sectionId: string, limit: number): void {
    this.visibleSessionLimits.set(sectionId, limit);
    this.requestSessionDataUpdate();
  }

  dismissSessionMutationError(): void {
    publishSidebarSessionError(this, null, "action");
    this.requestSessionDataUpdate();
  }

  resetSessionList(): void {
    this.retireFilteredSessions();
    this.sessionsLoading = false;
    this.visibleSessionLimits.clear();
    // A filter transition owns a new child/lineage generation; otherwise a
    // pending request from the retired view can repopulate its cleared rows.
    this.resetChildSessionState();
    this.sessionResultsByAgent = {};
    if (!hasSidebarListFilter(this.host) && this.context) {
      this.sessionsResult = this.context.sessions.presentation.result;
      this.sessionsAgentId = this.context.sessions.presentation.agentId;
    } else if (this.context) {
      this.bindFilteredSessions();
    }
    this.requestSessionDataUpdate();
  }

  discardEmptyChildSessionSnapshot(sessionKey: string): void {
    if (this.childSessionRowsByParent[sessionKey]?.length === 0) {
      const childRows = { ...this.childSessionRowsByParent };
      delete childRows[sessionKey];
      this.childSessionRowsByParent = childRows;
      const loadedKeys = new Set(this.loadedChildSessionKeys);
      loadedKeys.delete(sessionKey);
      this.loadedChildSessionKeys = loadedKeys;
      this.requestSessionDataUpdate();
    }
  }

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

  beginSessionMutation(): SidebarSessionMutationScope | null {
    const context = this.context;
    if (!context || !this.host.connected) {
      return null;
    }
    const gateway = context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    publishSidebarSessionError(this, null, "action");
    this.requestSessionDataUpdate();
    return {
      epoch: this.sessionMutationEpoch,
      context,
      gateway,
      sessions: context.sessions,
      client,
      selectedAgentId: this.host.selectedAgentIdForSessions(),
      signal: this.sessionMutationAbortController.signal,
    };
  }

  isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean {
    const context = this.context;
    const gateway = context?.gateway;
    return (
      this.host.connected &&
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
