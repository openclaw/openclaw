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
import {
  refreshSessionCatalogsLive,
  SessionCatalogLiveState,
} from "./app-sidebar-session-catalog-live.ts";
import {
  excludeSessionCatalogRows,
  mergeSessionCatalogPage,
  preserveExpandedCatalogHost,
  refetchExpandedSessionCatalogPages,
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
  readonly sessionCatalogPageDepths: Map<string, number>;
  sessionCatalogGatewayClient(): GatewayBrowserClient | null;
  synchronizeSessionScope(): void;
  requestSessionDataUpdate(): void;
  refreshSessionCatalogs(): Promise<void>;
  sessionCatalogIdsWithoutVisibleRows(): readonly string[];
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
  withdrawFreshSessionCatalogs(owner);
}

function withdrawFreshSessionCatalogs(
  owner: SessionCatalogDataOwner,
  error?: SessionCatalog["error"],
): void {
  owner.sessionCatalogs = owner.sessionCatalogs.map((catalog) =>
    catalog.requiresFreshList
      ? {
          ...catalog,
          pending: error ? undefined : true,
          ...(error ? { error } : {}),
          hosts: catalog.hosts.map((host) =>
            preserveExpandedCatalogHost(
              { ...host, pending: error ? undefined : true, ...(error ? { error } : {}) },
              undefined,
              true,
            ),
          ),
        }
      : catalog,
  );
  owner.requestSessionDataUpdate();
}

export function resetSessionCatalogConnection(owner: SessionCatalogResetOwner): void {
  retireSessionCatalogData(owner);
  owner.sessionCatalogRevision += 1;
  owner.sessionCatalogs = [];
  owner.sessionCatalogRefreshStatus = createPanelRefreshStatus();
  owner.sessionCatalogPageDepths.clear();
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
  return (
    !status.error &&
    (!canCallGatewayMethod(
      owner.context.gateway.snapshot,
      "sessions.catalog.list",
      "operator.read",
    ) ||
      (status.hasLoaded &&
        !status.awaitingGateway &&
        owner.sessionCatalogLive.requestGeneration === null &&
        owner.loadingMoreSessionCatalogIds.size === 0 &&
        owner.sessionCatalogs.every(
          (catalog) =>
            !catalog.pending &&
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
  if (update.replay) {
    void replayFreshSessionCatalogHost(owner, update.replay);
  }
  if (owner.sessionCatalogRowsVisible) {
    owner.requestSessionDataUpdate();
  }
}

async function replayFreshSessionCatalogHost(
  owner: SessionCatalogDataOwner,
  catalog: SessionCatalog,
): Promise<void> {
  const client = owner.sessionCatalogGatewayClient();
  const agentId = owner.sessionCatalogAgentId;
  if (!client || !agentId) {
    return;
  }
  const generation = owner.sessionScopeGeneration;
  const scope = owner.sessionCatalogLive.refreshScope;
  const host = catalog.hosts[0]!;
  const pending = preserveExpandedCatalogHost({ ...host, pending: true }, undefined, true);
  const replaceHost = (replacement: typeof host) => {
    owner.sessionCatalogs = owner.sessionCatalogs.map((current) =>
      current.id === catalog.id
        ? {
            ...current,
            hosts: current.hosts.map((entry) =>
              entry.hostId === host.hostId ? replacement : entry,
            ),
          }
        : current,
    );
    owner.requestSessionDataUpdate();
  };
  replaceHost(pending);
  const isCurrent = () =>
    isCurrentSessionCatalogRequest(owner, client, generation) &&
    owner.sessionCatalogLive.refreshScope === scope &&
    owner.sessionCatalogs
      .find((current) => current.id === catalog.id)
      ?.hosts.find((entry) => entry.hostId === host.hostId) === pending;
  // A late progressive host uses the same replay owner as the aggregate list.
  // Its previous window cannot authorize rows while these pages are pending.
  const [replayed] = await refetchExpandedSessionCatalogPages({
    catalogs: [catalog],
    previousCatalogs: [],
    client,
    agentId,
    pageDepths: owner.sessionCatalogPageDepths,
    isCurrent,
    canRequestPage: () => isCurrent() && document.visibilityState !== "hidden",
  });
  if (isCurrent() && replayed?.hosts[0]) {
    replaceHost(replayed.hosts[0]);
  }
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
    currentClient: () => owner.sessionCatalogGatewayClient(),
    catalogs: () => owner.sessionCatalogs,
    pageDepths: owner.sessionCatalogPageDepths,
    connected: () => owner.isSessionDataHostConnected,
    withdrawPrevious: () => {
      owner.loadingMoreSessionCatalogIds = new Set();
      withdrawFreshSessionCatalogs(owner);
    },
    applyFinal: (catalogs) => {
      owner.sessionCatalogs = owner.sessionCatalogLive.resumeDiscovery(catalogs);
      owner.sessionCatalogRefreshStatus = completePanelRefresh();
      owner.requestSessionDataUpdate();
    },
    continueRefresh: () => discoverHiddenSessionCatalogPages(owner),
    applyError: (error) => {
      withdrawFreshSessionCatalogs(owner, sessionCatalogRequestError(error));
      owner.sessionCatalogRefreshStatus = failPanelRefresh(
        owner.sessionCatalogRefreshStatus,
        error,
        owner.context.gateway.snapshot,
      );
      owner.requestSessionDataUpdate();
    },
    refresh: () => refreshSessionCatalogsInBackground(owner),
  });
  owner.requestSessionDataUpdate();
}

function hiddenSessionCatalogPages(owner: SessionCatalogDataOwner) {
  const hiddenIds = new Set(owner.sessionCatalogIdsWithoutVisibleRows());
  return owner.sessionCatalogs.flatMap((catalog) => {
    if (!hiddenIds.has(catalog.id) || catalog.pending || catalog.error) {
      return [];
    }
    const hostIds = catalog.hosts
      .filter((host) => host.nextCursor && !host.pending && !host.error)
      .map((host) => host.hostId);
    return hostIds.length > 0 ? [{ catalogId: catalog.id, hostIds }] : [];
  });
}

async function discoverHiddenSessionCatalogPages(owner: SessionCatalogDataOwner): Promise<void> {
  const generation = owner.sessionScopeGeneration;
  const scope = owner.sessionCatalogLive.refreshScope;
  const client = visibleSessionCatalogClient(owner);
  if (!client || !owner.isSessionDataHostConnected) {
    return;
  }
  // Empty prefixes belong to this finite cursor sweep, not a window that root
  // refreshes must replay. Errors and repeated cursors stop the affected host.
  while (
    generation === owner.sessionScopeGeneration &&
    scope === owner.sessionCatalogLive.refreshScope &&
    client === visibleSessionCatalogClient(owner) &&
    owner.isSessionDataHostConnected
  ) {
    const pages = hiddenSessionCatalogPages(owner);
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
  withdrawFreshSessionCatalogs(owner);
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
  const cursors = Object.fromEntries(
    (catalog?.hosts ?? []).flatMap((host) =>
      host.nextCursor && (!hostIds || hostIds.includes(host.hostId))
        ? [[host.hostId, host.nextCursor] as const]
        : [],
    ),
  );
  const retryFresh =
    catalog?.requiresFreshList && (catalog.error || catalog.hosts.some((host) => host.error));
  if (!catalog || (Object.keys(cursors).length === 0 && !retryFresh)) {
    return;
  }
  const client = owner.sessionCatalogGatewayClient();
  const agentId = resolveSessionCatalogAgentId(owner);
  if (!client || !agentId || agentId !== owner.sessionCatalogAgentId) {
    return;
  }
  if (catalog.requiresFreshList) {
    // Reauthorize the entire expanded window; appending a fresh page would retain
    // earlier rows whose source permission may have changed in the meantime.
    if (!retryFresh) {
      for (const hostId of Object.keys(cursors)) {
        const key = sessionCatalogHostKey(catalogId, hostId);
        owner.sessionCatalogPageDepths.set(key, (owner.sessionCatalogPageDepths.get(key) ?? 0) + 1);
      }
    }
    if (owner.sessionCatalogLive.requestGeneration === owner.sessionScopeGeneration) {
      owner.sessionCatalogLive.refreshPending = true;
    } else {
      // Hidden-page discovery already runs within the background bootstrap owner.
      await owner.refreshSessionCatalogs();
    }
    return;
  }
  const generation = owner.sessionScopeGeneration;
  const scope = owner.sessionCatalogLive.refreshScope;
  const isCurrent = () =>
    isCurrentSessionCatalogRequest(owner, client, generation) &&
    owner.sessionCatalogLive.refreshScope === scope;
  owner.loadingMoreSessionCatalogIds = new Set([...owner.loadingMoreSessionCatalogIds, catalogId]);
  owner.requestSessionDataUpdate();
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId,
      catalogId,
      hostIds: Object.keys(cursors),
      cursors,
    });
    if (!isCurrent()) {
      return;
    }
    const page = result.catalogs.find((candidate) => candidate.id === catalogId);
    const current = owner.sessionCatalogs.find((candidate) => candidate.id === catalogId);
    if (!current) {
      return;
    }
    const discoveryPages = owner.sessionCatalogLive.discoveryPages;
    const merged = mergeSessionCatalogPage({
      current,
      page,
      cursors,
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
    for (const [hostId, cursor] of Object.entries(cursors)) {
      if (!merged.advancedHostIds.includes(hostId)) {
        continue;
      }
      const key = sessionCatalogHostKey(catalogId, hostId);
      const discovery = discoveryPages.get(key);
      const previous = current.hosts.find((host) => host.hostId === hostId);
      const nextHost = merged.catalog.hosts.find((host) => host.hostId === hostId);
      const depth = (discovery?.depth ?? owner.sessionCatalogPageDepths.get(key) ?? 0) + 1;
      if (
        discovering &&
        previous?.sessions.length === 0 &&
        nextHost?.sessions.length === 0 &&
        !owner.sessionCatalogPageDepths.has(key)
      ) {
        if (nextHost.nextCursor) {
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
        owner.sessionCatalogPageDepths.set(key, depth);
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
    // Preserve rows and cursors: retrying Load More requests this page again.
    owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
      candidate.id === catalogId
        ? { ...candidate, error: sessionCatalogRequestError(error) }
        : candidate,
    );
    owner.requestSessionDataUpdate();
    owner.sessionCatalogRevision += 1;
  } finally {
    if (isCurrent()) {
      const loading = new Set(owner.loadingMoreSessionCatalogIds);
      loading.delete(catalogId);
      owner.loadingMoreSessionCatalogIds = loading;
      owner.requestSessionDataUpdate();
    }
  }
}

function isCurrentSessionCatalogRequest(
  owner: SessionCatalogDataOwner,
  client: GatewayBrowserClient,
  generation: number,
): boolean {
  return (
    generation === owner.sessionScopeGeneration && client === owner.sessionCatalogGatewayClient()
  );
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
