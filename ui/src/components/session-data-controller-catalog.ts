import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalog,
  SessionsCatalogArchiveParams,
  SessionsCatalogImportParams,
  SessionsCatalogImportResult,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { PresencePayload } from "../app/user-profile.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { readSessionMethodScopeAccess } from "../lib/session-method-access.ts";
import {
  buildCatalogSessionKey,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { SolidControllerHost } from "../lit/solid-controller-host.ts";
import {
  SessionCatalogLiveState,
  sessionCatalogListClient,
} from "./app-sidebar-session-catalog-live.ts";
import {
  hiddenSessionCatalogPages,
  refreshSessionCatalogsLive,
} from "./app-sidebar-session-catalog-refresh.ts";
import {
  excludeSessionCatalogRows,
  mergeSessionCatalogPage,
  refetchExpandedSessionCatalogPages,
  withdrawSessionCatalogRows,
  sessionCatalogRequestError,
} from "./app-sidebar-session-catalog-state.ts";
import { bindAdoptedCatalogSession } from "./app-sidebar-session-catalogs.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";
import type {
  SidebarSessionMutationScope,
  SidebarCatalogSessionMutationScope,
  SidebarSessionOwnerFilter,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import {
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
  type PanelRefreshStatus,
} from "./panel-refresh-status.ts";
import type { ContextualSidebar } from "./sidebar-context-state.ts";

export interface SessionDataControllerHost extends SolidControllerHost {
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
  readonly sessionDataContext: ApplicationContext | undefined;
  dismissTransientMenus(): boolean;
  expandedAgentId(): string;
  promoteCreatedSession(sessionKey: string): void;
  selectedAgentIdForSessions(): string;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
  sidebarSessionOwnerFilter(): SidebarSessionOwnerFilter;
  sessionCatalogIdsWithoutVisibleRows(): readonly string[];
  querySelector(selectors: string): Element | null;
}

export interface SessionCatalogDataOwner {
  readonly context: ApplicationContext | undefined;
  readonly isSessionDataHostConnected: boolean;
  readonly sessionDataHostConnected: boolean;
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
  sessionsLoading: boolean;
}

export function retireSessionCatalogData(owner: SessionCatalogResetOwner): void {
  owner.sessionScopeGeneration += 1;
  owner.pendingCatalogArchives = new Set();
  owner.sessionsLoading = false;
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
  return sessionCatalogListClient(owner.context?.gateway.snapshot, owner.sessionDataHostConnected);
}

function refreshSessionCatalogsInBackground(owner: SessionCatalogDataOwner): Promise<void> {
  const context = owner.context;
  if (!context) {
    return Promise.resolve();
  }
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
  const gateway = context?.gateway.snapshot;
  // Only an authoritative connected hello can revoke catalog ownership; a
  // transient reconnect still preserves its rows until the replacement lands.
  if (
    gateway?.phase === "connected" &&
    !canCallGatewayMethod(gateway, "sessions.catalog.list", "operator.read")
  ) {
    return null;
  }
  const agentsState = context?.agents.state;
  const agentsList =
    gateway?.phase === "connected" &&
    gateway.client &&
    agentsState?.connected &&
    agentsState.client === gateway.client
      ? agentsState.agentsList
      : null;
  const rawSelected = context?.agentSelection.state.selectedId;
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
  if (gateway?.phase !== "connected" || !gateway.hello || !gateway.assistantAgentId) {
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
  const snapshot = owner.context?.gateway.snapshot;
  return owner.sessionCatalogLive.requestRefresh({
    visible: document.visibilityState !== "hidden",
    connected:
      owner.isSessionDataHostConnected &&
      owner.sessionCatalogAgentId !== null &&
      Boolean(sessionCatalogListClient(snapshot, owner.sessionDataHostConnected)),
    generation: owner.sessionScopeGeneration,
    refresh: () => refreshSessionCatalogsInBackground(owner),
  });
}

export function updateSessionCatalogData(owner: SessionCatalogDataOwner): void {
  if (owner.context) {
    owner.synchronizeSessionScope();
  }
  if (
    !visibleSessionCatalogClient(owner) ||
    owner.sessionCatalogLive.hasRequested ||
    owner.sessionCatalogLive.requestGeneration === owner.sessionScopeGeneration
  ) {
    return;
  }
  void refreshSessionCatalogsInBackground(owner);
}

function sessionCatalogChangesAdvertised(owner: SessionCatalogDataOwner): boolean {
  const events = owner.context?.gateway.snapshot.hello?.features?.events;
  return events?.includes("sessions.catalog.changed") === true;
}

export function applySessionCatalogChanged(owner: SessionCatalogDataOwner, payload: unknown): void {
  if (!sessionCatalogChangesAdvertised(owner)) {
    return;
  }
  const agentId = asNullableRecord(payload)?.agentId;
  if (typeof agentId !== "string" || normalizeAgentId(agentId) === owner.sessionCatalogAgentId) {
    scheduleSessionCatalogRefresh(owner);
  }
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
    const [page] = await refetchExpandedSessionCatalogPages({
      catalogs: [{ ...catalog, hosts: [host] }],
      previousCatalogs: [],
      client,
      agentId,
      pageDepths: owner.sessionCatalogPageDepths,
      isCurrent,
      canRequestPage: () => isCurrent() && document.visibilityState !== "hidden",
    });
    if (!isCurrent()) {
      return;
    }
    // Only this host was replayed. Sibling publications may have advanced while
    // its pages were in flight and must survive the merge.
    owner.sessionCatalogs = owner.sessionCatalogs.map((current) =>
      current.id === catalogId
        ? {
            ...current,
            hosts: current.hosts.map((entry) =>
              entry.hostId === hostId ? page!.hosts[0]! : entry,
            ),
          }
        : current,
    );
    owner.sessionCatalogLive.finishWindow(
      page!,
      hostId,
      owner.sessionCatalogPageDepths.get(sessionCatalogHostKey(catalogId, hostId)) ?? 0,
    );
    owner.sessionCatalogRevision += 1;
    owner.requestSessionDataUpdate();
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
    catalogChangedEvents: sessionCatalogChangesAdvertised(owner),
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
        owner.context?.gateway.snapshot,
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
  if (
    !client ||
    !owner.sessionDataHostConnected ||
    !agentId ||
    agentId !== owner.sessionCatalogAgentId
  ) {
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
    const discoveryPages = owner.sessionCatalogLive.discoveryPages;
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
    const current = owner.sessionCatalogs.find((candidate) => candidate.id === catalogId);
    if (!current) {
      return;
    }
    const merged = mergeSessionCatalogPage({
      current,
      page,
      cursors,
      ...(catalog.requiresFreshList ? { freshHostIds: requestedHostIds } : {}),
      previousCursors: new Map(
        current.hosts.flatMap((host) => {
          const discovery = discoveryPages.get(sessionCatalogHostKey(catalogId, host.hostId));
          return discovery ? [[host.hostId, discovery.cursors] as const] : [];
        }),
      ),
    });
    for (const hostId of merged.repeatedHostIds) {
      discoveryPages.delete(sessionCatalogHostKey(catalogId, hostId));
    }
    for (const hostId of requestedHostIds) {
      const cursor = cursors[hostId];
      live.finishWindow(
        merged.catalog,
        hostId,
        pageDepths.get(sessionCatalogHostKey(catalogId, hostId)) ?? 0,
      );
      if (!merged.advancedHostIds.includes(hostId)) {
        continue;
      }
      const key = sessionCatalogHostKey(catalogId, hostId);
      const discovery = discoveryPages.get(key);
      const previous = current.hosts.find((host) => host.hostId === hostId);
      const nextHost = merged.catalog.hosts.find((host) => host.hostId === hostId);
      const depth = pageDepths.get(key) ?? 0;
      if (
        discovering &&
        previous?.sessions.length === 0 &&
        nextHost?.sessions.length === 0 &&
        !owner.sessionCatalogPageDepths.has(key)
      ) {
        if (nextHost.nextCursor && cursor) {
          const seenCursors = discovery?.cursors ?? new Set<string>();
          seenCursors.add(cursor);
          discoveryPages.set(key, {
            headCursor: discovery?.headCursor ?? cursor,
            nextCursor: nextHost.nextCursor,
            depth,
            cursors: seenCursors,
          });
        } else {
          // Renew the sweep at the next invalidation: membership can change behind a cursor.
          discoveryPages.delete(key);
        }
      } else {
        discoveryPages.delete(key);
        live.windows.set(key, { depth });
      }
    }
    owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
      candidate.id === catalogId ? merged.catalog : candidate,
    );
    owner.requestSessionDataUpdate();
    owner.sessionCatalogRevision += 1;
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
  owner: SessionCatalogDataOwner & {
    pendingCatalogArchives: ReadonlySet<string>;
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
    invalidateSessionCatalogs(): void;
  },
  scope: SidebarCatalogSessionMutationScope,
  params: SessionsCatalogArchiveParams,
): Promise<void> {
  const generation = scope.catalogGeneration;
  const key = buildCatalogSessionKey(params);
  owner.pendingCatalogArchives = new Set([...owner.pendingCatalogArchives, key]);
  owner.requestSessionDataUpdate();
  try {
    await scope.client.request("sessions.catalog.archive", params);
    if (generation === owner.sessionScopeGeneration && owner.isSessionMutationScopeCurrent(scope)) {
      owner.sessionCatalogs = excludeSessionCatalogRows(owner.sessionCatalogs, new Set([key]));
      owner.invalidateSessionCatalogs();
    }
  } finally {
    if (generation === owner.sessionScopeGeneration) {
      owner.pendingCatalogArchives = new Set(
        [...owner.pendingCatalogArchives].filter((entry) => entry !== key),
      );
      owner.requestSessionDataUpdate();
    }
  }
}

export async function importSessionCatalog(
  owner: SessionCatalogDataOwner & {
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
    refreshSidebarSessions(agentId?: string): Promise<void>;
  },
  scope: SidebarCatalogSessionMutationScope,
  params: SessionsCatalogImportParams,
): Promise<SessionsCatalogImportResult | null> {
  const isCurrent = () =>
    scope.catalogGeneration === owner.sessionScopeGeneration &&
    owner.isSessionMutationScopeCurrent(scope);
  if (!isCurrent()) {
    return null;
  }
  const access = readSessionMethodScopeAccess(scope.gateway.snapshot.hello?.auth, {
    method: "sessions.catalog.import",
    requiredScope: "operator.write",
  });
  if (!access.allowed) {
    throw new Error(access.reason);
  }
  const result = await scope.client.request<SessionsCatalogImportResult>(
    "sessions.catalog.import",
    params,
  );
  if (!isCurrent()) {
    return null;
  }
  void owner.refreshSidebarSessions(params.agentId);
  return result;
}
