import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalog,
  SessionsCatalogHostEvent,
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
  isRepeatedCatalogCursorError,
  preserveExpandedCatalogHost,
  withdrawSessionCatalogRows,
} from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

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
  private request: {
    owner: symbol;
    generation: number;
    phase: "head" | "replay" | "discovery";
  } | null = null;
  // Presentation intent, never cached rows or authority-bearing cursors.
  readonly windows = new Map<
    string,
    { depth: number; request?: { depth: number; status: "available" | "retry" } }
  >();
  private readonly publishedWindows = new Map<string, { catalogId: string; hostId: string }>();

  get requestGeneration() {
    return this.request?.generation ?? null;
  }
  get refetching() {
    return this.request?.phase === "replay";
  }
  get canReplayPublication() {
    return !this.request || this.request.phase === "discovery";
  }
  get pageDepths(): ReadonlyMap<string, number> {
    return new Map(
      [...this.windows]
        .filter(([, window]) => window.depth > 0)
        .map(([key, window]) => [key, window.depth]),
    );
  }
  requestedDepth(catalogId: string, hostId: string) {
    return this.windows.get(sessionCatalogHostKey(catalogId, hostId))?.request?.depth;
  }
  canRetry(catalog: SessionCatalog) {
    return (
      catalog.requiresFreshList === true &&
      (Boolean(catalog.error) ||
        catalog.hosts.some(
          (host) =>
            this.windows.get(sessionCatalogHostKey(catalog.id, host.hostId))?.request?.status ===
            "retry",
        ))
    );
  }
  finishWindow(catalog: SessionCatalog, hostId: string, depth: number) {
    if (!catalog.requiresFreshList) {
      return;
    }
    const key = sessionCatalogHostKey(catalog.id, hostId);
    const host = catalog.hosts.find((entry) => entry.hostId === hostId);
    const error = catalog.error ?? host?.error;
    if (host?.pending && !error) {
      // Pending is not a completed authorization or a settled retry attempt.
      return;
    }
    const previousDepth = this.windows.get(key)?.depth ?? 0;
    if (error && !isRepeatedCatalogCursorError(error)) {
      this.windows.set(key, { depth: previousDepth, request: { depth, status: "retry" } });
    } else if (previousDepth > 0) {
      this.windows.set(key, { depth: previousDepth });
    } else {
      this.windows.delete(key);
    }
  }
  withdraw(catalogs: SessionCatalog[]) {
    for (const catalog of catalogs) {
      if (!catalog.requiresFreshList) {
        continue;
      }
      for (const host of catalog.hosts) {
        if (!host.nextCursor) {
          continue;
        }
        const key = sessionCatalogHostKey(catalog.id, host.hostId);
        const depth = this.windows.get(key)?.depth ?? 0;
        this.windows.set(key, { depth, request: { depth: depth + 1, status: "available" } });
      }
    }
    return catalogs.map((catalog) => withdrawSessionCatalogRows(catalog));
  }

  settleRootWindows(
    catalogs: SessionCatalog[],
    error?: SessionCatalog["error"],
    acceptsHost: (catalogId: string, hostId: string) => boolean = () => true,
  ) {
    const keys = new Set(
      catalogs.flatMap((catalog) =>
        catalog.hosts.map((host) => sessionCatalogHostKey(catalog.id, host.hostId)),
      ),
    );
    for (const [key, window] of this.windows) {
      if (
        catalogs.some((catalog) =>
          catalog.hosts.some(
            (host) =>
              sessionCatalogHostKey(catalog.id, host.hostId) === key &&
              !acceptsHost(catalog.id, host.hostId),
          ),
        )
      ) {
        continue;
      }
      if (
        catalogs.some(
          (catalog) =>
            catalog.requiresFreshList &&
            (error || catalog.error) &&
            key.startsWith(sessionCatalogHostKey(catalog.id, "")),
        )
      ) {
        // A provider failure can omit all hosts. Preserve only window intent
        // until fresh discovery can identify the currently authorized hosts.
        continue;
      }
      if (!keys.has(key) || window.request?.status === "available") {
        if (window.depth > 0) {
          this.windows.set(key, { depth: window.depth });
        } else {
          this.windows.delete(key);
        }
      }
    }
    for (const catalog of catalogs) {
      const result = error ? { ...catalog, error } : catalog;
      for (const host of catalog.hosts) {
        if (!acceptsHost(catalog.id, host.hostId)) {
          continue;
        }
        const window = this.windows.get(sessionCatalogHostKey(catalog.id, host.hostId));
        const depth =
          window?.request?.status === "retry" ? window.request.depth : (window?.depth ?? 0);
        this.finishWindow(result, host.hostId, depth);
      }
    }
  }

  takePublishedWindows() {
    if (!this.canReplayPublication) {
      return [];
    }
    const windows = [...this.publishedWindows.values()];
    this.publishedWindows.clear();
    return windows;
  }
  setRequestPhase(owner: symbol, phase: "replay" | "discovery") {
    if (this.request?.owner === owner) {
      this.request.phase = phase;
      if (phase === "replay") {
        this.publishedWindows.clear();
      }
    }
  }
  endRequest(owner: symbol) {
    if (this.request?.owner === owner) {
      this.request = null;
    }
  }
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
  private progressSequence = 0;
  private readonly progressSequences = new Map<string, number>();
  private readonly hostProgressSequences = new Map<string, number>();
  private knownHostKeys = new Set<string>();
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
    this.request = null;
    this.publishedWindows.clear();
    for (const [key, window] of this.windows) {
      if (window.depth > 0) {
        this.windows.set(key, { depth: window.depth });
      } else {
        this.windows.delete(key);
      }
    }
    this.progressSequence = 0;
    this.progressSequences.clear();
    this.hostProgressSequences.clear();
    this.knownHostKeys.clear();
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
            : preserveExpandedCatalogHost(host, progressiveHost, catalog);
        }
        if (catalog.requiresFreshList) {
          return preserveExpandedCatalogHost(host, undefined, catalog);
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
    return this.progressSequence > 0;
  }

  beginRequest(generation: number): {
    progressId: string;
    progressSequence: number;
    requestOwner: symbol;
  } {
    this.eventRefresh.absorb();
    this.activationRefresh = null;
    const requestOwner = Symbol("session-catalog-request");
    this.request = { owner: requestOwner, generation, phase: "head" };
    this.publishedWindows.clear();
    // A new root read does not itself replace an existing retry intent.
    // Only an accepted current result or scope retirement may do that.
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

  retireHostPublications(catalogId: string, hostIds: readonly string[]) {
    for (const hostId of hostIds) {
      const key = sessionCatalogHostKey(catalogId, hostId);
      // Targeted refreshes have no progress stream. Only the next root request
      // may publish these hosts again; other hosts keep their current stream.
      this.hostProgressSequences.set(key, this.progressSequence + 1);
      this.requestChangedHostKeys.delete(key);
      this.publishedWindows.delete(key);
    }
  }

  acceptsRootHost(catalogId: string, hostId: string, sequence: number) {
    return (
      sequence >= (this.hostProgressSequences.get(sessionCatalogHostKey(catalogId, hostId)) ?? -1)
    );
  }

  ownsRequest(owner: symbol) {
    return this.request?.owner === owner;
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
        this.hostProgressSequences.set(
          hostKey,
          Math.max(this.hostProgressSequences.get(hostKey) ?? -1, params.progressSequence),
        );
      }
    }
    this.knownHostKeys = finalHostKeys;
  }

  applyHost(params: {
    payload: unknown;
    agentId: string;
    catalogs: SessionCatalog[];
    pageDepths: ReadonlyMap<string, number>;
  }): { catalogs: SessionCatalog[]; catalogId: string; hostId: string } | null {
    if (!isSessionsCatalogHostEvent(params.payload)) {
      return null;
    }
    const event = params.payload;
    if (normalizeAgentId(event.agentId) !== normalizeAgentId(params.agentId)) {
      return null;
    }
    const currentCatalog = params.catalogs.find((catalog) => catalog.id === event.catalog.id);
    const sequence = this.progressSequences.get(event.progressId);
    const freshHost = event.catalog.hosts[0];
    if (
      sequence === undefined ||
      !freshHost ||
      ((event.catalog.requiresFreshList || currentCatalog?.requiresFreshList) &&
        sequence < this.progressSequence)
    ) {
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
    let catalogs: SessionCatalog[];
    let nextCatalog: SessionCatalog;
    if (!currentCatalog) {
      nextCatalog = {
        ...event.catalog,
        hosts: [preserveExpandedCatalogHost(freshHost, undefined, event.catalog)],
      };
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
        event.catalog.requiresFreshList ||
        freshHost.pending ||
        (params.pageDepths.get(hostKey) ?? 0) > 0 ||
        this.discoveryPages.has(hostKey)
          ? preserveExpandedCatalogHost(freshHost, currentHost, event.catalog)
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
      currentCatalog.requiresFreshList === nextCatalog.requiresFreshList &&
      JSON.stringify(currentCatalog.capabilities) === JSON.stringify(nextCatalog.capabilities) &&
      JSON.stringify(currentCatalog.error) === JSON.stringify(nextCatalog.error);
    if (sameCatalogMetadata && JSON.stringify(currentHost) === JSON.stringify(nextHost)) {
      return null;
    }
    this.publishedWindows.set(hostKey, { catalogId: event.catalog.id, hostId: freshHost.hostId });
    this.finishWindow(nextCatalog, freshHost.hostId, params.pageDepths.get(hostKey) ?? 0);
    return { catalogs, catalogId: event.catalog.id, hostId: freshHost.hostId };
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
