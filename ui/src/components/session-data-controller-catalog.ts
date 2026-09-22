import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReactiveControllerHost } from "lit";
import type {
  SessionCatalog,
  SessionsCatalogArchiveParams,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import {
  buildCatalogSessionKey,
  type CatalogSessionContinuedDetail,
} from "../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  refreshSessionCatalogsLive,
  SessionCatalogLiveState,
  sessionCatalogListClient,
} from "./app-sidebar-session-catalog-live.ts";
import {
  excludeSessionCatalogRows,
  mergeSessionCatalogPage,
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
  failPanelRefresh,
  type PanelRefreshStatus,
} from "./panel-refresh-status.ts";

export interface SessionDataControllerHost extends ReactiveControllerHost {
  readonly isConnected: boolean;
  readonly connected: boolean;
  readonly activeRouteId?: string;
  getRouteSessionKey(): string;
  readonly sessionDataContext: ApplicationContext<RouteId> | undefined;
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
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly isSessionDataHostConnected: boolean;
  readonly sessionDataHostConnected: boolean;
  sessionCatalogs: SessionCatalog[];
  sessionCatalogRefreshStatus: PanelRefreshStatus;
  loadingMoreSessionCatalogIds: ReadonlySet<string>;
  readonly sessionCatalogLive: SessionCatalogLiveState;
  sessionCatalogAgentId: string | null;
  readonly sessionScopeGeneration: number;
  sessionCatalogRevision: number;
  readonly sessionCatalogPageDepths: Map<string, number>;
  readonly sessionCatalogRevisions: Map<string, number>;
  expandedAgentId(): string;
  sessionCatalogGatewayClient(): GatewayBrowserClient | null;
  synchronizeSessionScope(): void;
  requestSessionDataUpdate(): void;
  refreshSessionCatalogs(): Promise<void>;
  sessionCatalogIdsWithoutVisibleRows(): readonly string[];
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

export function resolveSessionCatalogAgentId(
  owner: SessionCatalogDataOwner,
  candidateAgentId: string | null | undefined = owner.expandedAgentId(),
): string | null {
  const context = owner.context;
  const gateway = context?.gateway.snapshot;
  // Only an authoritative connected hello can revoke catalog ownership; a
  // transient reconnect still preserves its rows until the replacement lands.
  if (
    gateway?.phase === "connected" &&
    isGatewayMethodAdvertised(gateway, "sessions.catalog.list") === false
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
  if (agentsList) {
    const rawSelectedId = context ? context.agentSelection.state.selectedId : candidateAgentId;
    const selectedId = rawSelectedId?.trim() ? normalizeAgentId(rawSelectedId) : null;
    if (
      selectedId &&
      agentsList.agents.some((agent) => normalizeAgentId(agent.id) === selectedId)
    ) {
      return selectedId;
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
  const rawSelected = context?.agentSelection.state.selectedId;
  const selected = rawSelected?.trim() ? normalizeAgentId(rawSelected) : null;
  // An explicit pre-roster selection may target an agent hello knows nothing about;
  // defer until the roster can validate it instead of fetching the default's catalog.
  return selected && selected !== helloDefault ? null : helloDefault;
}

export function scheduleSessionCatalogRefresh(owner: SessionCatalogDataOwner): void {
  if (document.visibilityState === "hidden") {
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
  return (
    owner.context?.gateway.snapshot.hello?.features?.events?.includes(
      "sessions.catalog.changed",
    ) === true
  );
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
  owner.requestSessionDataUpdate();
  owner.sessionCatalogRevision += owner.sessionCatalogLive.refetching ? 1 : 0;
  const catalogRevision = owner.sessionCatalogRevisions.get(update.catalogId) ?? 0;
  owner.sessionCatalogRevisions.set(update.catalogId, catalogRevision + 1);
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
  const revision = owner.sessionCatalogRevision;
  await refreshSessionCatalogsLive({
    live: owner.sessionCatalogLive,
    client,
    agentId,
    generation,
    revision,
    currentGeneration: () => owner.sessionScopeGeneration,
    currentRevision: () => owner.sessionCatalogRevision,
    currentClient: () => owner.sessionCatalogGatewayClient(),
    catalogs: () => owner.sessionCatalogs,
    pageDepths: owner.sessionCatalogPageDepths,
    connected: () => owner.isSessionDataHostConnected,
    catalogChangedEvents: sessionCatalogChangesAdvertised(owner),
    applyFinal: (catalogs, revisedCatalogIds) => {
      owner.sessionCatalogs = owner.sessionCatalogLive.resumeDiscovery(catalogs);
      owner.sessionCatalogRefreshStatus = completePanelRefresh();
      owner.requestSessionDataUpdate();
      for (const catalogId of revisedCatalogIds) {
        owner.sessionCatalogRevisions.set(
          catalogId,
          (owner.sessionCatalogRevisions.get(catalogId) ?? 0) + 1,
        );
      }
      owner.sessionCatalogRevision += 1;
    },
    continueRefresh: () => discoverHiddenSessionCatalogPages(owner),
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
}

function hiddenSessionCatalogPages(owner: SessionCatalogDataOwner) {
  const hiddenIds = new Set(owner.sessionCatalogIdsWithoutVisibleRows());
  return owner.sessionCatalogs.flatMap((catalog) => {
    if (!hiddenIds.has(catalog.id) || catalog.error) {
      return [];
    }
    const hostIds = catalog.hosts
      .filter((host) => host.nextCursor && !host.error)
      .map((host) => host.hostId);
    return hostIds.length > 0 ? [{ catalogId: catalog.id, hostIds }] : [];
  });
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
  owner.sessionCatalogRevision += 1;
  for (const { id } of owner.sessionCatalogs) {
    owner.sessionCatalogRevisions.set(id, (owner.sessionCatalogRevisions.get(id) ?? 0) + 1);
  }
  void requestSessionCatalogRefresh(owner);
}

export async function loadMoreSessionCatalog(
  owner: SessionCatalogDataOwner,
  catalogId: string,
  hostIds?: readonly string[],
  discovering = false,
): Promise<void> {
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
  if (!catalog || Object.keys(cursors).length === 0) {
    return;
  }
  const client = owner.context?.gateway.snapshot.client;
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
  const revision = owner.sessionCatalogRevisions.get(catalogId) ?? 0;
  owner.loadingMoreSessionCatalogIds = new Set([...owner.loadingMoreSessionCatalogIds, catalogId]);
  owner.requestSessionDataUpdate();
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId,
      catalogId,
      hostIds: Object.keys(cursors),
      cursors,
    });
    if (!isCurrentSessionCatalogRequest(owner, catalogId, client, generation, revision)) {
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
    owner.sessionCatalogRevisions.set(catalogId, revision + 1);
    owner.sessionCatalogRevision += 1;
  } catch (error) {
    if (!isCurrentSessionCatalogRequest(owner, catalogId, client, generation, revision)) {
      return;
    }
    // Preserve rows and cursors: retrying Load More requests this page again.
    owner.sessionCatalogs = owner.sessionCatalogs.map((candidate) =>
      candidate.id === catalogId
        ? { ...candidate, error: sessionCatalogRequestError(error) }
        : candidate,
    );
    owner.requestSessionDataUpdate();
    owner.sessionCatalogRevisions.set(catalogId, revision + 1);
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

function isCurrentSessionCatalogRequest(
  owner: SessionCatalogDataOwner,
  catalogId: string,
  client: GatewayBrowserClient,
  generation: number,
  revision: number,
): boolean {
  return (
    generation === owner.sessionScopeGeneration &&
    revision === (owner.sessionCatalogRevisions.get(catalogId) ?? 0) &&
    client === owner.sessionCatalogGatewayClient()
  );
}

export async function archiveSessionCatalog(
  owner: SessionCatalogDataOwner & {
    readonly pendingCatalogArchives: Set<string>;
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
    invalidateSessionCatalogs(): void;
  },
  scope: SidebarCatalogSessionMutationScope,
  params: SessionsCatalogArchiveParams,
): Promise<void> {
  const generation = scope.catalogGeneration;
  const key = buildCatalogSessionKey(params);
  owner.pendingCatalogArchives.add(key);
  owner.requestSessionDataUpdate();
  try {
    await scope.client.request("sessions.catalog.archive", params);
    if (generation === owner.sessionScopeGeneration && owner.isSessionMutationScopeCurrent(scope)) {
      owner.sessionCatalogs = excludeSessionCatalogRows(owner.sessionCatalogs, new Set([key]));
      // Retire pre-delete reads before releasing the optimistic hide.
      owner.invalidateSessionCatalogs();
    }
  } finally {
    if (generation === owner.sessionScopeGeneration) {
      owner.pendingCatalogArchives.delete(key);
      owner.requestSessionDataUpdate();
    }
  }
}
