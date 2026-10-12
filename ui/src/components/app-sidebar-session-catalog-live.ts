import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalog,
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  isAgentDatabaseInspectionPendingError,
  isAwaitingGatewayFailure,
  resolveGatewayReadRetryDelayMs,
} from "../lib/gateway-availability.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { createSessionEventRefreshCoordinator } from "../lib/sessions/event-refresh-coordinator.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { generateUUID } from "../lib/uuid.ts";
import {
  preserveExpandedCatalogHost,
  refetchExpandedSessionCatalogPages,
} from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

const SESSION_CATALOG_SAFETY_REFRESH_MS = 10 * 60_000;
const SESSION_CATALOG_STABLE_REFRESH_MS = 30_000;
const SESSION_CATALOG_MAX_RETRIES = 3;

export function sessionCatalogListClient(
  snapshot: ApplicationGatewaySnapshot | undefined,
  connected: boolean,
): GatewayBrowserClient | null {
  if (
    !connected ||
    !snapshot?.client ||
    !canCallGatewayMethod(snapshot, "sessions.catalog.list", "operator.read")
  ) {
    return null;
  }
  return snapshot.client;
}

function isSessionsCatalogHostEvent(value: unknown): value is SessionsCatalogHostEvent {
  const event = asNullableRecord(value);
  const catalog = asNullableRecord(event?.catalog);
  const hosts = Array.isArray(catalog?.hosts) ? catalog.hosts : [];
  const host = asNullableRecord(hosts[0]);
  return Boolean(
    event &&
    catalog &&
    host &&
    typeof event.progressId === "string" &&
    event.progressId.length > 0 &&
    typeof event.agentId === "string" &&
    event.agentId.length > 0 &&
    typeof catalog.id === "string" &&
    typeof catalog.label === "string" &&
    catalog.capabilities !== null &&
    typeof catalog.capabilities === "object" &&
    hosts.length === 1 &&
    typeof host.hostId === "string" &&
    Array.isArray(host.sessions),
  );
}

/** Tracks one sidebar's progressive list streams and event refresh lifecycle. */
export class SessionCatalogLiveState {
  refreshScope = {};
  timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  requestGeneration: number | null = null;
  refreshPending = false;
  readonly discoveryPages = new Map<
    string,
    { headCursor: string; nextCursor: string; depth: number; cursors: Set<string> }
  >();

  private activationRefresh: (() => Promise<void> | void) | null = null;
  private readonly eventRefresh = createSessionEventRefreshCoordinator({
    active: true,
    refresh: async () => {
      const refresh = this.activationRefresh;
      this.activationRefresh = null;
      await refresh?.();
    },
  });
  private readonly progressIds = new Set<string>();
  private readonly requestChangedHostKeys = new Set<string>();
  private readonly warnedRequestErrors = new Set<string>();
  private retryAttempts = 0;
  private retryAt = 0;
  startupPending = false;

  get retryDelayMs() {
    return Math.max(0, this.retryAt - Date.now());
  }

  resetRetry() {
    this.retryAttempts = 0;
    this.retryAt = 0;
    this.startupPending = false;
  }

  retryRequest(error: unknown): number | null {
    this.startupPending = isAgentDatabaseInspectionPendingError(error);
    if (this.startupPending) {
      const delay = resolveGatewayReadRetryDelayMs(error, this.retryAttempts++);
      this.retryAt = Date.now() + delay;
      return delay;
    }
    if (
      !(error instanceof GatewayRequestError) ||
      !error.retryable ||
      isAwaitingGatewayFailure(error, null) ||
      this.retryAttempts >= SESSION_CATALOG_MAX_RETRIES
    ) {
      this.resetRetry();
      return null;
    }
    const serverDelay =
      typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : 0;
    const delay = Math.max(serverDelay, 1_000 * 2 ** this.retryAttempts++);
    this.retryAt = Date.now() + delay;
    return delay;
  }

  cancelTimer() {
    const handle = this.timer;
    if (handle !== null) {
      globalThis.clearTimeout(handle);
      this.timer = null;
    }
  }

  clear() {
    this.refreshScope = {};
    this.cancelScheduledRefreshes();
    this.resetRetry();
    this.requestGeneration = null;
    this.progressIds.clear();
    this.requestChangedHostKeys.clear();
    this.refreshPending = false;
    this.discoveryPages.clear();
  }

  resumeDiscovery(catalogs: SessionCatalog[]): SessionCatalog[] {
    const currentKeys = new Set<string>();
    const result = catalogs.map((catalog) => ({
      ...catalog,
      hosts: catalog.hosts.map((host) => {
        const key = sessionCatalogHostKey(catalog.id, host.hostId);
        currentKeys.add(key);
        const discovery = this.discoveryPages.get(key);
        if (!discovery || host.pending || host.error || catalog.error) {
          return host;
        }
        // Recheck the head on each refresh. A changed anchor or newly visible row
        // starts fresh; empty prefixes only belong to the current finite sweep.
        if (host.sessions.length > 0 || host.nextCursor !== discovery.headCursor) {
          this.discoveryPages.delete(key);
          return host;
        }
        return { ...host, nextCursor: discovery.nextCursor };
      }),
    }));
    for (const key of this.discoveryPages.keys()) {
      if (!currentKeys.has(key)) {
        this.discoveryPages.delete(key);
      }
    }
    return result;
  }

  mergeFinal(catalogs: SessionCatalog[], currentCatalogs: readonly SessionCatalog[]) {
    const currentHosts = new Map(
      currentCatalogs.flatMap((catalog) =>
        catalog.hosts.map(
          (host) => [sessionCatalogHostKey(catalog.id, host.hostId), host] as const,
        ),
      ),
    );
    return catalogs.map((catalog) => ({
      ...catalog,
      hosts: catalog.hosts.map((host) => {
        const hostKey = sessionCatalogHostKey(catalog.id, host.hostId);
        const progressiveHost = currentHosts.get(hostKey);
        if (host.pending) {
          return this.requestChangedHostKeys.has(hostKey) &&
            progressiveHost &&
            !progressiveHost.pending
            ? progressiveHost
            : preserveExpandedCatalogHost(host, progressiveHost);
        }
        return host.error &&
          this.requestChangedHostKeys.has(hostKey) &&
          progressiveHost &&
          !progressiveHost.error
          ? progressiveHost
          : host;
      }),
    }));
  }

  get hasRequested() {
    return this.progressIds.size > 0;
  }

  beginRequest(generation: number): { progressId: string } {
    this.eventRefresh.absorb();
    this.activationRefresh = null;
    this.requestGeneration = generation;
    this.requestChangedHostKeys.clear();
    const progressId = generateUUID();
    this.progressIds.add(progressId);
    if (this.progressIds.size > 8) {
      this.progressIds.delete(this.progressIds.values().next().value!);
    }
    return { progressId };
  }

  warnRequestError(error: unknown) {
    const code = error instanceof GatewayRequestError ? error.gatewayCode : "UNAVAILABLE";
    const message = formatUiError(error);
    const signature = `${code}\u0000${message}`;
    if (this.warnedRequestErrors.has(signature)) {
      return;
    }
    this.warnedRequestErrors.add(signature);
    console.warn("Session catalog refresh failed", error);
  }

  applyHost(params: {
    payload: unknown;
    agentId: string;
    catalogs: SessionCatalog[];
    pageDepths: ReadonlyMap<string, number>;
  }): { catalogs: SessionCatalog[]; catalogId: string } | null {
    if (!isSessionsCatalogHostEvent(params.payload)) {
      return null;
    }
    const event = params.payload;
    if (normalizeAgentId(event.agentId) !== normalizeAgentId(params.agentId)) {
      return null;
    }
    const freshHost = event.catalog.hosts[0];
    if (!this.progressIds.has(event.progressId) || !freshHost) {
      return null;
    }
    const hostKey = sessionCatalogHostKey(event.catalog.id, freshHost.hostId);
    if (this.requestGeneration !== null) {
      this.requestChangedHostKeys.add(hostKey);
    }
    const currentCatalog = params.catalogs.find((catalog) => catalog.id === event.catalog.id);
    let catalogs: SessionCatalog[];
    let nextCatalog: SessionCatalog;
    if (!currentCatalog) {
      nextCatalog = { ...event.catalog, hosts: [freshHost] };
      catalogs = [...params.catalogs, nextCatalog].toSorted((left, right) =>
        left.id.localeCompare(right.id),
      );
    } else {
      const currentHost = currentCatalog.hosts.find((host) => host.hostId === freshHost.hostId);
      const discovery = this.discoveryPages.get(hostKey);
      if (
        discovery &&
        !freshHost.pending &&
        !freshHost.error &&
        (freshHost.sessions.length > 0 || freshHost.nextCursor !== discovery.headCursor)
      ) {
        this.discoveryPages.delete(hostKey);
      }
      const mergedHost =
        freshHost.pending ||
        (params.pageDepths.get(hostKey) ?? 0) > 0 ||
        this.discoveryPages.has(hostKey)
          ? preserveExpandedCatalogHost(freshHost, currentHost)
          : freshHost;
      const hosts = currentHost
        ? currentCatalog.hosts.map((host) => (host.hostId === freshHost.hostId ? mergedHost : host))
        : [...currentCatalog.hosts, mergedHost];
      nextCatalog = {
        ...event.catalog,
        hosts: hosts.toSorted((left, right) => left.label.localeCompare(right.label)),
      };
      catalogs = params.catalogs.map((catalog) =>
        catalog.id === event.catalog.id ? nextCatalog : catalog,
      );
    }
    const currentHost = currentCatalog?.hosts.find((host) => host.hostId === freshHost.hostId);
    const nextHost = nextCatalog.hosts.find((host) => host.hostId === freshHost.hostId);
    const sameCatalogMetadata =
      currentCatalog !== undefined &&
      currentCatalog.label === nextCatalog.label &&
      JSON.stringify(currentCatalog.capabilities) === JSON.stringify(nextCatalog.capabilities) &&
      JSON.stringify(currentCatalog.error) === JSON.stringify(nextCatalog.error);
    if (sameCatalogMetadata && JSON.stringify(currentHost) === JSON.stringify(nextHost)) {
      return null;
    }
    return { catalogs, catalogId: event.catalog.id };
  }

  schedule(delayMs: number, isConnected: boolean, refresh: () => void) {
    if (document.visibilityState === "hidden" || !isConnected) {
      return;
    }
    this.cancelTimer();
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      refresh();
    }, delayMs);
  }

  async requestRefresh(params: {
    visible: boolean;
    connected: boolean;
    generation: number;
    refresh: () => Promise<void>;
  }) {
    if (!params.visible || !params.connected) {
      return;
    }
    this.cancelTimer();
    if (this.requestGeneration === params.generation) {
      this.refreshPending = true;
    }
    await params.refresh();
  }

  cancelActivation() {
    this.eventRefresh.reset();
    this.activationRefresh = null;
  }

  cancelScheduledRefreshes() {
    this.cancelTimer();
    this.cancelActivation();
  }

  scheduleActivation(refresh: () => Promise<void> | void) {
    this.activationRefresh = refresh;
    this.eventRefresh.schedule();
  }
}

/** Runs one progressive list/reconciliation cycle without binding it to a Lit element. */
export async function refreshSessionCatalogsLive(params: {
  live: SessionCatalogLiveState;
  client: GatewayBrowserClient;
  agentId: string;
  generation: number;
  currentGeneration: () => number;
  currentClient: () => GatewayBrowserClient | null;
  catalogs: () => SessionCatalog[];
  pageDepths: ReadonlyMap<string, number>;
  connected: () => boolean;
  catalogChangedEvents: boolean;
  applyFinal: (catalogs: SessionCatalog[]) => void;
  /** Finish the finite cursor sweep without repeating the root catalog request. */
  continueRefresh: () => Promise<void>;
  applyError: (error: unknown) => void;
  refresh: () => Promise<void>;
}) {
  const { live, client, generation } = params;
  if (live.requestGeneration === generation) {
    return;
  }
  // Events and returning tabs share the same cooldown as the scheduled retry.
  if (live.retryDelayMs > 0) {
    live.schedule(live.retryDelayMs, params.connected(), () => void params.refresh());
    return;
  }
  const { progressId } = live.beginRequest(generation);
  let retryDelayMs: number | null = null;
  const requestIsCurrent = () =>
    generation === params.currentGeneration() && client === params.currentClient();
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId: params.agentId,
      limitPerHost: 40,
      progressId,
      allowPartialResults: true,
    });
    if (!requestIsCurrent() || !result?.catalogs) {
      return;
    }
    const previousCatalogs = params.catalogs();
    const catalogs = await refetchExpandedSessionCatalogPages({
      catalogs: live.mergeFinal(result.catalogs, previousCatalogs),
      previousCatalogs,
      client,
      agentId: params.agentId,
      pageDepths: params.pageDepths,
      isCurrent: requestIsCurrent,
      canRequestPage: () => requestIsCurrent() && document.visibilityState !== "hidden",
    });
    if (!requestIsCurrent()) {
      return;
    }
    live.resetRetry();
    params.applyFinal(catalogs);
    await params.continueRefresh();
  } catch (error) {
    // A transient refresh failure must not collapse already visible or expanded pages.
    if (requestIsCurrent()) {
      retryDelayMs = live.retryRequest(error);
      if (live.startupPending) {
        params.applyError(error);
      } else if (retryDelayMs === null) {
        live.warnRequestError(error);
        params.applyError(error);
      }
    }
  } finally {
    if (requestIsCurrent()) {
      live.requestGeneration = null;
    }
    if (requestIsCurrent() && params.connected()) {
      const pending = live.refreshPending;
      live.refreshPending = false;
      const interval =
        retryDelayMs ??
        (params.catalogChangedEvents
          ? SESSION_CATALOG_SAFETY_REFRESH_MS
          : SESSION_CATALOG_STABLE_REFRESH_MS);
      live.schedule(interval, params.connected(), () => {
        void params.refresh();
      });
      if (pending && retryDelayMs === null) {
        live.scheduleActivation(params.refresh);
      }
    }
  }
}
