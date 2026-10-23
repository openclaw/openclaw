import type {
  SessionCatalog,
  SessionsCatalogImportResult,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type { CatalogSessionContinuedDetail } from "../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import {
  hiddenSessionCatalogPages,
  refreshSessionCatalogsLive,
} from "./app-sidebar-session-catalog-refresh.ts";
import {
  refetchExpandedSessionCatalogPages,
  withdrawSessionCatalogRows,
  sessionCatalogRequestError,
} from "./app-sidebar-session-catalog-state.ts";
import { bindAdoptedCatalogSession } from "./app-sidebar-session-catalogs.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";
import type {
  SidebarSessionOwnerFilter,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import {
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
  type PanelRefreshStatus,
} from "./panel-refresh-status-state.ts";
import type { ContextualSidebar } from "./sidebar-context-state.ts";

export interface SessionDataInputs {
  readonly isConnected: boolean;
  readonly connected: boolean;
  readonly navigationVisible: boolean;
  readonly navigationView: "sessions" | "online" | "pages";
  readonly contextualSidebar?: ContextualSidebar;
  readonly sidebarAgentsMode: "chip" | "roster";
  shouldPublishSessionData(): boolean;
  readonly activeRouteId?: string;
  readonly sessionCatalogRowsVisible: boolean;
  samePresence(previous: PresencePayload | undefined, next: PresencePayload | undefined): boolean;
  getRouteSessionKey(): string;
  childSessionParents(): Set<string>;
  readonly sessionDataContext: ApplicationContext;
  dismissTransientMenus(): boolean;
  expandedAgentId(): string;
  promoteCreatedSession(sessionKey: string): void;
  selectedAgentIdForSessions(): string;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
  sidebarSessionOwnerFilter(): SidebarSessionOwnerFilter;
  sessionCatalogIdsWithoutVisibleRows(): readonly string[];
}

export interface SessionCatalogDataOwner {
  readonly context: ApplicationContext;
  readonly isSessionDataHostConnected: boolean;
  readonly sessionCatalogRowsVisible: boolean;
  sessionCatalogs: SessionCatalog[];
  sessionCatalogRefreshStatus: PanelRefreshStatus;
  loadingMoreSessionCatalogIds: ReadonlySet<string>;
  readonly sessionCatalogLive: SessionCatalogLiveState;
  sessionCatalogAgentId: string | null;
  readonly sessionScopeGeneration: number;
  sessionCatalogRevision: number;
  readonly sessionCatalogPageDepths: ReadonlyMap<string, number>;
  readonly sessionCatalogRevisions: Map<string, number>;
  sessionCatalogGatewayClient(): GatewayBrowserClient | null;
  synchronizeSessionScope(): void;
  requestSessionDataUpdate(): void;
  refreshSessionCatalogs(): Promise<void>;
  sessionCatalogIdsWithoutVisibleRows(): readonly string[];
}

function captureSessionCatalogRequest(
  owner: SessionCatalogDataOwner,
  catalogId: string,
  client: GatewayBrowserClient,
  hostIds: readonly string[],
): () => boolean {
  const generation = owner.sessionScopeGeneration;
  const revision = owner.sessionCatalogRevisions.get(catalogId) ?? 0;
  const currentHosts = () =>
    owner.sessionCatalogs.find((catalog) => catalog.id === catalogId)?.hosts;
  const hosts = currentHosts()?.filter((host) => hostIds.includes(host.hostId)) ?? [];
  // Host snapshots are immutable publications. A sibling update does not retire
  // this read; a root refresh, adoption, or replacement of any requested host does.
  return () =>
    generation === owner.sessionScopeGeneration &&
    revision === (owner.sessionCatalogRevisions.get(catalogId) ?? 0) &&
    client === owner.sessionCatalogGatewayClient() &&
    hosts.every((host) => currentHosts()?.find((entry) => entry.hostId === host.hostId) === host);
}

interface SessionCatalogResetOwner extends SessionCatalogDataOwner {
  sessionScopeGeneration: number;
  pendingCatalogArchives: ReadonlySet<string>;
}

export function retireSessionCatalogData(owner: SessionCatalogResetOwner): void {
  owner.sessionScopeGeneration += 1;
  owner.pendingCatalogArchives = new Set();
  owner.loadingMoreSessionCatalogIds = new Set();
  owner.sessionCatalogLive.clear();
}

/** Agent changes and reconnects both discard source rows and their authorization windows. */
export function clearSessionCatalogRows(owner: SessionCatalogDataOwner): void {
  owner.sessionCatalogs = [];
  owner.sessionCatalogLive.windows.clear();
  owner.sessionCatalogRevisions.clear();
}

export function resetSessionCatalogConnection(owner: SessionCatalogResetOwner): void {
  retireSessionCatalogData(owner);
  owner.sessionCatalogRevision += 1;
  clearSessionCatalogRows(owner);
  owner.sessionCatalogRefreshStatus = createPanelRefreshStatus();
  owner.requestSessionDataUpdate();
}

/** A completed list RPC can still leave pending hosts or hidden discovery pages. */
export function areSessionCatalogsSettled(
  owner: Pick<
    SessionCatalogDataOwner,
    | "context"
    | "sessionCatalogs"
    | "sessionCatalogRefreshStatus"
    | "sessionCatalogLive"
    | "loadingMoreSessionCatalogIds"
  >,
): boolean {
  const status = owner.sessionCatalogRefreshStatus;
  const gateway = owner.context?.gateway.snapshot;
  return (
    !status.error &&
    (!canCallGatewayMethod(gateway, "sessions.catalog.list", "operator.read") ||
      (status.hasLoaded &&
        !status.awaitingGateway &&
        owner.sessionCatalogLive.requestGeneration === null &&
        owner.loadingMoreSessionCatalogIds.size === 0 &&
        owner.sessionCatalogs.every(
          (catalog) =>
            !catalog.pending &&
            !owner.sessionCatalogLive.canRetry(catalog) &&
            !catalog.error &&
            catalog.hosts.every((entry) => !entry.pending && !entry.error && !entry.nextCursor),
        )))
  );
}

function visibleSessionCatalogClient(owner: SessionCatalogDataOwner): GatewayBrowserClient | null {
  if (document.visibilityState === "hidden") {
    return null;
  }
  return owner.sessionCatalogGatewayClient();
}

function refreshSessionCatalogsInBackground(owner: SessionCatalogDataOwner): Promise<void> {
  const context = owner.context;
  const scope = owner.sessionCatalogLive.refreshScope;
  return context.connectionBootstrap.run(
    scope,
    async () => {
      if (
        owner.context === context &&
        owner.sessionCatalogLive.refreshScope === scope &&
        owner.isSessionDataHostConnected
      ) {
        await owner.refreshSessionCatalogs();
      }
    },
    { background: true },
  );
}

export function resolveSessionCatalogAgentId(owner: SessionCatalogDataOwner): string | null {
  const context = owner.context;
  const gateway = context.gateway.snapshot;
  // Only an authoritative connected hello can revoke catalog ownership; a
  // transient reconnect still preserves its rows until the replacement lands.
  if (
    gateway.phase === "connected" &&
    !canCallGatewayMethod(gateway, "sessions.catalog.list", "operator.read")
  ) {
    return null;
  }
  const agentsState = context.agents.state;
  const agentsList =
    gateway.phase === "connected" &&
    gateway.client &&
    agentsState.connected &&
    agentsState.client === gateway.client
      ? agentsState.agentsList
      : null;
  const rawSelected = context.agentSelection.state.selectedId;
  const selected = rawSelected?.trim() ? normalizeAgentId(rawSelected) : null;
  if (agentsList) {
    if (selected && agentsList.agents.some((agent) => normalizeAgentId(agent.id) === selected)) {
      return selected;
    }
    const defaultId = normalizeAgentId(agentsList.defaultId);
    return agentsList.agents.some((agent) => normalizeAgentId(agent.id) === defaultId)
      ? defaultId
      : null;
  }
  if (gateway.phase !== "connected" || !gateway.hello || !gateway.assistantAgentId) {
    return null;
  }
  const helloDefault = normalizeAgentId(gateway.assistantAgentId);
  // An explicit pre-roster selection may target an agent hello knows nothing about;
  // defer until the roster can validate it instead of fetching the default's catalog.
  return selected && selected !== helloDefault ? null : helloDefault;
}

export function scheduleSessionCatalogRefresh(owner: SessionCatalogDataOwner): void {
  if (!visibleSessionCatalogClient(owner)) {
    owner.sessionCatalogLive.cancelScheduledRefreshes();
    return;
  }
  owner.sessionCatalogLive.scheduleActivation(() => requestSessionCatalogRefresh(owner));
}

function requestSessionCatalogRefresh(owner: SessionCatalogDataOwner): Promise<void> {
  return owner.sessionCatalogLive.requestRefresh({
    visible: document.visibilityState !== "hidden",
    connected:
      owner.isSessionDataHostConnected &&
      owner.sessionCatalogAgentId !== null &&
      Boolean(owner.sessionCatalogGatewayClient()),
    generation: owner.sessionScopeGeneration,
    refresh: () => refreshSessionCatalogsInBackground(owner),
  });
}

export function updateSessionCatalogData(owner: SessionCatalogDataOwner): void {
  owner.synchronizeSessionScope();
  if (
    !visibleSessionCatalogClient(owner) ||
    owner.sessionCatalogLive.hasRequested ||
    owner.sessionCatalogLive.requestGeneration === owner.sessionScopeGeneration
  ) {
    return;
  }
  void refreshSessionCatalogsInBackground(owner);
}

export function applySessionCatalogHostEvent(
  owner: SessionCatalogDataOwner,
  payload: unknown,
): void {
  const update = owner.sessionCatalogLive.applyHost({
    payload,
    agentId: owner.sessionCatalogAgentId ?? "",
    catalogs: owner.sessionCatalogs,
    pageDepths: owner.sessionCatalogPageDepths,
  });
  if (!update) {
    return;
  }
  owner.sessionCatalogs = update.catalogs;
  if (owner.sessionCatalogRowsVisible) {
    owner.requestSessionDataUpdate();
  }
  void resumePublishedSessionCatalogWindows(owner);
}

async function resumePublishedSessionCatalogWindows(owner: SessionCatalogDataOwner): Promise<void> {
  await Promise.all(
    owner.sessionCatalogLive
      .takePublishedWindows()
      .map(({ catalogId, hostId }) => resumePublishedSessionCatalogHost(owner, catalogId, hostId)),
  );
}

async function resumePublishedSessionCatalogHost(
  owner: SessionCatalogDataOwner,
  catalogId: string,
  hostId: string,
): Promise<void> {
  const client = visibleSessionCatalogClient(owner);
  const agentId = owner.sessionCatalogAgentId;
  const catalog = owner.sessionCatalogs.find((entry) => entry.id === catalogId);
  const host = catalog?.hosts.find((entry) => entry.hostId === hostId);
  if (!client || !agentId || !catalog || !host || !owner.isSessionDataHostConnected) {
    return;
  }
  if (
    catalog.requiresFreshList &&
    !catalog.error &&
    !host.pending &&
    !host.error &&
    host.nextCursor &&
    (owner.sessionCatalogPageDepths.get(sessionCatalogHostKey(catalogId, hostId)) ?? 0) > 0
  ) {
    const isCurrent = captureSessionCatalogRequest(owner, catalogId, client, [hostId]);
    const pageDepths = owner.sessionCatalogPageDepths;
    const { replayPublishedSessionCatalogHost } =
      await import("./app-sidebar-session-catalog-pages.runtime.ts");
    if (
      !(await replayPublishedSessionCatalogHost({
        owner,
        catalog,
        host,
        client,
        agentId,
        pageDepths,
        isCurrent,
      }))
    ) {
      return;
    }
  }
  await discoverHiddenSessionCatalogPages(owner);
}

export function applySessionCatalogContinuation(
  owner: SessionCatalogDataOwner,
  detail: CatalogSessionContinuedDetail,
): void {
  const rawAgentId = typeof detail?.agentId === "string" ? detail.agentId.trim() : "";
  const eventAgentId = rawAgentId ? normalizeAgentId(rawAgentId) : null;
  const currentAgentId = owner.sessionCatalogAgentId
    ? normalizeAgentId(owner.sessionCatalogAgentId)
    : null;
  if (!detail?.sessionKey || !eventAgentId || eventAgentId !== currentAgentId) {
    return;
  }
  owner.sessionCatalogLive.discoveryPages.clear();
  owner.sessionCatalogs = bindAdoptedCatalogSession(owner.sessionCatalogs, detail);
  owner.requestSessionDataUpdate();
  // Invalidate in-flight reads and load-more merges so a pre-adoption
  // snapshot cannot clobber the patched rows; Gateway events reconfirm them.
  owner.sessionCatalogRevision += 1;
  owner.sessionCatalogRevisions.set(
    detail.catalogId,
    (owner.sessionCatalogRevisions.get(detail.catalogId) ?? 0) + 1,
  );
}

export async function refreshSessionCatalogs(owner: SessionCatalogDataOwner): Promise<void> {
  // Hidden pages resume through the coalesced visibility handler.
  owner.synchronizeSessionScope();
  const agentId = owner.sessionCatalogAgentId;
  const client = visibleSessionCatalogClient(owner);
  if (!client || !agentId) {
    return;
  }
  const generation = owner.sessionScopeGeneration;
  // Publish the existing request lifecycle to settled-empty presentation too.
  owner.requestSessionDataUpdate();
  await refreshSessionCatalogsLive({
    live: owner.sessionCatalogLive,
    client,
    agentId,
    generation,
    currentGeneration: () => owner.sessionScopeGeneration,
    catalogRevisions: owner.sessionCatalogRevisions,
    currentClient: () => owner.sessionCatalogGatewayClient(),
    catalogs: () => owner.sessionCatalogs,
    pageDepths: owner.sessionCatalogPageDepths,
    connected: () => owner.isSessionDataHostConnected,
    applyPending: (catalogs) => {
      owner.sessionCatalogs = catalogs;
      for (const catalog of catalogs) {
        if (catalog.requiresFreshList) {
          owner.sessionCatalogRevisions.set(
            catalog.id,
            (owner.sessionCatalogRevisions.get(catalog.id) ?? 0) + 1,
          );
        }
      }
      owner.requestSessionDataUpdate();
    },
    applyFinal: (catalogs) => {
      owner.sessionCatalogs = owner.sessionCatalogLive.resumeDiscovery(catalogs);
      owner.sessionCatalogRefreshStatus = completePanelRefresh();
      owner.requestSessionDataUpdate();
      owner.sessionCatalogRevision += 1;
    },
    continueRefresh: async () => {
      await resumePublishedSessionCatalogWindows(owner);
      await discoverHiddenSessionCatalogPages(owner);
    },
    applyError: (error) => {
      owner.sessionCatalogRefreshStatus = failPanelRefresh(
        owner.sessionCatalogRefreshStatus,
        error,
        owner.context.gateway.snapshot,
      );
      owner.requestSessionDataUpdate();
    },
    refresh: () => refreshSessionCatalogsInBackground(owner),
  });
  // Even a failed or superseded aggregate can have accepted a host publication.
  // The live owner releases that work only after its head/replay phase retires.
  await resumePublishedSessionCatalogWindows(owner);
  owner.requestSessionDataUpdate();
}

async function discoverHiddenSessionCatalogPages(owner: SessionCatalogDataOwner): Promise<void> {
  const generation = owner.sessionScopeGeneration;
  const client = visibleSessionCatalogClient(owner);
  if (!client || !owner.isSessionDataHostConnected) {
    return;
  }
  // Empty prefixes belong to this finite cursor sweep, not a window that root
  // refreshes must replay. Errors and repeated cursors stop the affected host.
  while (
    generation === owner.sessionScopeGeneration &&
    client === visibleSessionCatalogClient(owner) &&
    owner.isSessionDataHostConnected
  ) {
    const hiddenIds = owner.sessionCatalogIdsWithoutVisibleRows();
    const pages = hiddenSessionCatalogPages(owner.sessionCatalogs, hiddenIds);
    if (pages.length === 0) {
      return;
    }
    const revision = owner.sessionCatalogRevision;
    await Promise.all(
      pages.map(({ catalogId, hostIds }) =>
        loadMoreSessionCatalog(owner, catalogId, hostIds, true),
      ),
    );
    if (revision === owner.sessionCatalogRevision) {
      return;
    }
  }
}

export function invalidateSessionCatalogs(owner: SessionCatalogDataOwner): void {
  owner.sessionCatalogLive.clear();
  void requestSessionCatalogRefresh(owner);
}

export async function loadMoreSessionCatalog(
  owner: SessionCatalogDataOwner,
  catalogId: string,
  hostIds?: readonly string[],
  discovering = false,
): Promise<void> {
  owner.synchronizeSessionScope();
  if (owner.loadingMoreSessionCatalogIds.has(catalogId)) {
    return;
  }
  const catalog = owner.sessionCatalogs.find((candidate) => candidate.id === catalogId);
  if (!discovering && catalog?.requiresFreshList && catalog.error) {
    // Provider errors belong to root discovery, even when a newer targeted read
    // retained one host. Only root discovery can reconcile the missing siblings.
    await requestSessionCatalogRefresh(owner);
    return;
  }
  const requestedHosts = (catalog?.hosts ?? []).filter(
    (host) =>
      (!hostIds || hostIds.includes(host.hostId)) &&
      (host.nextCursor ||
        (!discovering &&
          catalog?.requiresFreshList &&
          owner.sessionCatalogLive.requestedDepth(catalogId, host.hostId) !== undefined)),
  );
  const requestedHostIds = requestedHosts.map((host) => host.hostId);
  const cursors = Object.fromEntries(
    requestedHosts.flatMap((host) =>
      host.nextCursor ? [[host.hostId, host.nextCursor] as const] : [],
    ),
  );
  if (!catalog || requestedHostIds.length === 0) {
    return;
  }
  const client = owner.sessionCatalogGatewayClient();
  const agentId = resolveSessionCatalogAgentId(owner);
  if (!client || !agentId || agentId !== owner.sessionCatalogAgentId) {
    return;
  }
  const generation = owner.sessionScopeGeneration;
  const live = owner.sessionCatalogLive;
  const pageDepths = new Map(owner.sessionCatalogPageDepths);
  for (const hostId of requestedHostIds) {
    const key = sessionCatalogHostKey(catalogId, hostId);
    const depth =
      live.requestedDepth(catalogId, hostId) ??
      (live.discoveryPages.get(key)?.depth ?? pageDepths.get(key) ?? 0) + 1;
    pageDepths.set(key, depth);
    // Empty-page discovery owns a finite sweep, not an explicit expansion.
    if (catalog.requiresFreshList && !discovering) {
      live.windows.set(key, { ...live.windows.get(key), depth });
    }
  }
  // The targeted read owns these hosts; the root still owns its other sources.
  live.retireHostPublications(catalogId, requestedHostIds);
  owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
    candidate.id === catalogId
      ? withdrawSessionCatalogRows(candidate, requestedHostIds)
      : candidate,
  );
  const isCurrent = captureSessionCatalogRequest(owner, catalogId, client, requestedHostIds);
  owner.loadingMoreSessionCatalogIds = new Set([...owner.loadingMoreSessionCatalogIds, catalogId]);
  owner.requestSessionDataUpdate();
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId,
      catalogId,
      hostIds: requestedHostIds,
      ...(catalog.requiresFreshList ? {} : { cursors }),
    });
    if (!isCurrent()) {
      return;
    }
    let page = result.catalogs.find((candidate) => candidate.id === catalogId);
    if (catalog.requiresFreshList && page) {
      // A successful older page cannot authorize the previous head. Rebuild the
      // requested window in this cycle, using the same replay/error policy as refresh.
      [page] = await refetchExpandedSessionCatalogPages({
        catalogs: [page],
        previousCatalogs: [],
        client,
        agentId,
        pageDepths,
        isCurrent: () => isCurrent(),
        canRequestPage: () => isCurrent() && document.visibilityState !== "hidden",
      });
      if (!isCurrent()) {
        return;
      }
    }
    const { publishSessionCatalogPage } =
      await import("./app-sidebar-session-catalog-pages.runtime.ts");
    // Loading the page processor must not revive a read retired during the import.
    if (!isCurrent()) {
      return;
    }
    publishSessionCatalogPage({
      owner,
      catalog,
      page,
      cursors,
      requestedHostIds,
      pageDepths,
      discovering,
    });
  } catch (error) {
    if (!isCurrent()) {
      return;
    }
    // Ordinary catalogs retain their cursor; fresh catalogs retain only intent.
    const failure = { ...catalog, error: sessionCatalogRequestError(error) };
    for (const hostId of requestedHostIds) {
      live.finishWindow(
        failure,
        hostId,
        pageDepths.get(sessionCatalogHostKey(catalogId, hostId)) ?? 0,
      );
    }
    owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
      candidate.id === catalogId
        ? catalog.requiresFreshList
          ? {
              ...candidate,
              hosts: candidate.hosts.map((host) =>
                requestedHostIds.includes(host.hostId)
                  ? { ...host, error: sessionCatalogRequestError(error) }
                  : host,
              ),
            }
          : { ...candidate, error: sessionCatalogRequestError(error) }
        : candidate,
    );
    owner.requestSessionDataUpdate();
    owner.sessionCatalogRevision += 1;
  } finally {
    if (generation === owner.sessionScopeGeneration) {
      const loading = new Set(owner.loadingMoreSessionCatalogIds);
      loading.delete(catalogId);
      owner.loadingMoreSessionCatalogIds = loading;
      owner.requestSessionDataUpdate();
    }
  }
}

export async function archiveSessionCatalog(
  ...args: Parameters<
    typeof import("./session-data-catalog-actions.runtime.ts").archiveSessionCatalog
  >
): Promise<void> {
  const { archiveSessionCatalog: archiveCatalog } =
    await import("./session-data-catalog-actions.runtime.ts");
  const [owner, scope] = args;
  if (
    scope.catalogGeneration !== owner.sessionScopeGeneration ||
    !owner.isSessionMutationScopeCurrent(scope)
  ) {
    return;
  }
  return archiveCatalog(...args);
}

export async function importSessionCatalog(
  ...args: Parameters<
    typeof import("./session-data-catalog-actions.runtime.ts").importSessionCatalog
  >
): Promise<SessionsCatalogImportResult | null> {
  const { importSessionCatalog: importCatalog } =
    await import("./session-data-catalog-actions.runtime.ts");
  // The mutation owner rechecks its captured scope before making the RPC.
  return importCatalog(...args);
}
