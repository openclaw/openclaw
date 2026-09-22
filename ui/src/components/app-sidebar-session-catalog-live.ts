import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalog,
  SessionsCatalogHostEvent,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
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

export function sessionCatalogListClient(
  snapshot: ApplicationGatewaySnapshot | undefined,
  connected: boolean,
): GatewayBrowserClient | null {
  if (
    !connected ||
    snapshot?.phase !== "connected" ||
    !snapshot.client ||
    isGatewayMethodAdvertised(snapshot, "sessions.catalog.list") !== true
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
  private refetchOwner: symbol | null = null;
  private progressSequence = 0;
  private readonly progressSequences = new Map<string, number>();
  private readonly hostProgressSequences = new Map<string, number>();
  private knownHostKeys = new Set<string>();
  private readonly requestChangedHostKeys = new Set<string>();
  private readonly warnedRequestErrors = new Set<string>();
  private requestOwner: symbol | null = null;

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
    this.requestGeneration = null;
    this.requestOwner = null;
    this.progressSequence = 0;
    this.progressSequences.clear();
    this.hostProgressSequences.clear();
    this.knownHostKeys.clear();
    this.requestChangedHostKeys.clear();
    this.refreshPending = false;
    this.discoveryPages.clear();
    this.refetchOwner = null;
  }

  resumeDiscovery(catalogs: SessionCatalog[]): SessionCatalog[] {
    const currentKeys = new Set<string>();
    const result = catalogs.map((catalog) => ({
      ...catalog,
      hosts: catalog.hosts.map((host) => {
        const key = sessionCatalogHostKey(catalog.id, host.hostId);
        currentKeys.add(key);
        const discovery = this.discoveryPages.get(key);
        if (!discovery || host.error || catalog.error) {
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
        return host.error &&
          this.requestChangedHostKeys.has(hostKey) &&
          progressiveHost &&
          !progressiveHost.error
          ? progressiveHost
          : host;
      }),
    }));
  }

  get refetching() {
    return this.refetchOwner !== null;
  }

  get hasRequested() {
    return this.progressSequence > 0;
  }

  beginRefetch(active: boolean): symbol | null {
    if (!active) {
      return null;
    }
    const owner = Symbol("session-catalog-refetch");
    this.refetchOwner = owner;
    return owner;
  }

  endRefetch(owner: symbol | null) {
    if (owner !== null && this.refetchOwner === owner) {
      this.refetchOwner = null;
    }
  }

  beginRequest(generation: number): {
    progressId: string;
    progressSequence: number;
    requestOwner: symbol;
  } {
    this.eventRefresh.absorb();
    this.activationRefresh = null;
    this.requestGeneration = generation;
    const requestOwner = Symbol("session-catalog-request");
    this.requestOwner = requestOwner;
    this.requestChangedHostKeys.clear();
    const progressId = generateUUID();
    const progressSequence = ++this.progressSequence;
    this.progressSequences.set(progressId, progressSequence);
    if (this.progressSequences.size > 8) {
      const oldest = this.progressSequences.keys().next().value;
      if (oldest) {
        this.progressSequences.delete(oldest);
      }
    }
    return { progressId, progressSequence, requestOwner };
  }

  ownsRequest(owner: symbol) {
    return this.requestOwner === owner;
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

  markFinal(params: { catalogs: readonly SessionCatalog[]; progressSequence: number }) {
    const finalHostKeys = new Set<string>();
    for (const catalog of params.catalogs) {
      for (const host of catalog.hosts) {
        const key = sessionCatalogHostKey(catalog.id, host.hostId);
        finalHostKeys.add(key);
        if (host.error) {
          continue;
        }
        this.hostProgressSequences.set(
          key,
          Math.max(this.hostProgressSequences.get(key) ?? -1, params.progressSequence),
        );
      }
    }
    for (const hostKey of this.knownHostKeys) {
      if (!finalHostKeys.has(hostKey)) {
        this.hostProgressSequences.set(hostKey, params.progressSequence);
      }
    }
    this.knownHostKeys = finalHostKeys;
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
    const sequence = this.progressSequences.get(event.progressId);
    const freshHost = event.catalog.hosts[0];
    if (sequence === undefined || !freshHost) {
      return null;
    }
    const hostKey = sessionCatalogHostKey(event.catalog.id, freshHost.hostId);
    if (sequence < (this.hostProgressSequences.get(hostKey) ?? -1)) {
      return null;
    }
    this.hostProgressSequences.set(hostKey, sequence);
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
        !freshHost.error &&
        (freshHost.sessions.length > 0 || freshHost.nextCursor !== discovery.headCursor)
      ) {
        this.discoveryPages.delete(hostKey);
      }
      const mergedHost =
        (params.pageDepths.get(hostKey) ?? 0) > 0 || this.discoveryPages.has(hostKey)
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
  revision: number;
  currentGeneration: () => number;
  currentRevision: () => number;
  currentClient: () => GatewayBrowserClient | null;
  catalogs: () => SessionCatalog[];
  pageDepths: ReadonlyMap<string, number>;
  connected: () => boolean;
  catalogChangedEvents: boolean;
  applyFinal: (catalogs: SessionCatalog[], revisedCatalogIds: ReadonlySet<string>) => void;
  /** Finish the finite cursor sweep without repeating the root catalog request. */
  continueRefresh: () => Promise<void>;
  applyError: (error: unknown) => void;
  refresh: () => Promise<void>;
}) {
  const { live, client, generation, revision } = params;
  if (live.requestGeneration === generation) {
    return;
  }
  const { progressId, progressSequence, requestOwner } = live.beginRequest(generation);
  let refetchOwner: symbol | null = null;
  const requestIsCurrent = () =>
    live.ownsRequest(requestOwner) &&
    generation === params.currentGeneration() &&
    client === params.currentClient();
  const revisionIsCurrent = () => requestIsCurrent() && revision === params.currentRevision();
  try {
    const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId: params.agentId,
      limitPerHost: 40,
      progressId,
    });
    if (!requestIsCurrent() || !result?.catalogs) {
      return;
    }
    refetchOwner = live.beginRefetch(params.pageDepths.size > 0);
    const previousCatalogs = params.catalogs();
    const catalogs = await refetchExpandedSessionCatalogPages({
      catalogs: live.mergeFinal(result.catalogs, previousCatalogs),
      previousCatalogs,
      client,
      agentId: params.agentId,
      pageDepths: params.pageDepths,
      isCurrent: revisionIsCurrent,
      canRequestPage: () => revisionIsCurrent() && document.visibilityState !== "hidden",
    });
    if (!revisionIsCurrent()) {
      return;
    }
    params.applyFinal(
      catalogs,
      new Set([...params.catalogs(), ...catalogs].map((catalog) => catalog.id)),
    );
    live.markFinal({ catalogs, progressSequence });
    live.endRefetch(refetchOwner);
    refetchOwner = null;
    await params.continueRefresh();
  } catch (error) {
    // A transient refresh failure must not collapse already visible or expanded pages.
    if (revisionIsCurrent()) {
      live.warnRequestError(error);
      params.applyError(error);
    }
  } finally {
    live.endRefetch(refetchOwner);
    const ownsRequest = live.ownsRequest(requestOwner);
    if (ownsRequest) {
      live.requestGeneration = null;
    }
    if (ownsRequest && requestIsCurrent() && params.connected()) {
      const pending = live.refreshPending;
      live.refreshPending = false;
      const interval = params.catalogChangedEvents
        ? SESSION_CATALOG_SAFETY_REFRESH_MS
        : SESSION_CATALOG_STABLE_REFRESH_MS;
      live.schedule(interval, params.connected(), () => {
        void params.refresh();
      });
      if (pending) {
        live.scheduleActivation(params.refresh);
      }
    }
  }
}
