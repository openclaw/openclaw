import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionCatalogLiveState } from "./app-sidebar-session-catalog-live.ts";
import {
  refetchExpandedSessionCatalogPages,
  sessionCatalogRequestError,
} from "./app-sidebar-session-catalog-state.ts";

const SESSION_CATALOG_SAFETY_REFRESH_MS = 10 * 60_000;
const SESSION_CATALOG_STABLE_REFRESH_MS = 30_000;

/** Runs one progressive list/reconciliation cycle without binding it to a Lit element. */
export async function refreshSessionCatalogsLive(params: {
  live: SessionCatalogLiveState;
  client: GatewayBrowserClient;
  agentId: string;
  generation: number;
  currentGeneration: () => number;
  catalogRevisions: ReadonlyMap<string, number>;
  currentClient: () => GatewayBrowserClient | null;
  catalogs: () => SessionCatalog[];
  pageDepths: ReadonlyMap<string, number>;
  connected: () => boolean;
  catalogChangedEvents: boolean;
  applyPending: (catalogs: SessionCatalog[]) => void;
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
  const { progressId, progressSequence, requestOwner } = live.beginRequest(generation);
  params.applyPending(live.withdraw(params.catalogs()));
  const revisions = new Map(params.catalogRevisions);
  const acceptsCatalog = (catalogId: string) =>
    (revisions.get(catalogId) ?? 0) === (params.catalogRevisions.get(catalogId) ?? 0);
  const acceptsHost = (catalogId: string, hostId: string) =>
    acceptsCatalog(catalogId) && live.acceptsRootHost(catalogId, hostId, progressSequence);
  let retryDelayMs: number | null = null;
  const requestIsCurrent = () =>
    live.ownsRequest(requestOwner) &&
    generation === params.currentGeneration() &&
    client === params.currentClient();
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
    live.setRequestPhase(requestOwner, "replay");
    const previousCatalogs = params.catalogs();
    const catalogs = await refetchExpandedSessionCatalogPages({
      catalogs: live
        .mergeFinal(result.catalogs, previousCatalogs)
        .filter((catalog) => acceptsCatalog(catalog.id))
        .map((catalog) => {
          // mergeFinal allocated this root-owned catalog; never mutate the UI snapshot.
          catalog.hosts = catalog.hosts.filter((host) => acceptsHost(catalog.id, host.hostId));
          return catalog;
        }),
      previousCatalogs,
      client,
      agentId: params.agentId,
      pageDepths: params.pageDepths,
      isCurrent: (catalogId, hostId) => requestIsCurrent() && acceptsHost(catalogId, hostId),
      canRequestPage: (catalogId, hostId) =>
        requestIsCurrent() &&
        acceptsHost(catalogId, hostId) &&
        document.visibilityState !== "hidden",
    });
    if (!requestIsCurrent()) {
      return;
    }
    live.resetRetry();
    // A host published during replay owns a newer snapshot than the captured
    // aggregate. Keep it and replay its window after root application.
    const currentCatalogs = params.catalogs();
    const acceptedCatalogs = catalogs.map((catalog) => {
      const previous = previousCatalogs.find((entry) => entry.id === catalog.id);
      const current = currentCatalogs.find((entry) => entry.id === catalog.id);
      const newerHosts =
        current?.hosts.filter(
          (host) =>
            !acceptsHost(catalog.id, host.hostId) ||
            host !== previous?.hosts.find((entry) => entry.hostId === host.hostId),
        ) ?? [];
      if (!acceptsCatalog(catalog.id) && current) {
        return current;
      }
      return {
        ...catalog,
        ...(newerHosts.length > 0 ? current : undefined),
        hosts: [
          ...catalog.hosts.map(
            (host) => newerHosts.find((entry) => entry.hostId === host.hostId) ?? host,
          ),
          ...newerHosts.filter(
            (host) => !catalog.hosts.some((entry) => entry.hostId === host.hostId),
          ),
        ],
      };
    });
    for (const catalog of currentCatalogs) {
      if (
        !catalogs.some((entry) => entry.id === catalog.id) &&
        (!acceptsCatalog(catalog.id) ||
          !previousCatalogs.some((entry) => entry.id === catalog.id) ||
          catalog.hosts.some((host) => !acceptsHost(catalog.id, host.hostId)))
      ) {
        acceptedCatalogs.push(
          acceptsCatalog(catalog.id)
            ? {
                ...catalog,
                hosts: catalog.hosts.filter(
                  (host) =>
                    !acceptsHost(catalog.id, host.hostId) ||
                    !previousCatalogs.some((entry) => entry.id === catalog.id),
                ),
              }
            : catalog,
        );
      }
    }
    live.settleRootWindows(acceptedCatalogs, undefined, acceptsHost);
    params.applyFinal(acceptedCatalogs);
    live.markFinal({ catalogs: acceptedCatalogs, progressSequence });
    live.setRequestPhase(requestOwner, "discovery");
    await params.continueRefresh();
  } catch (error) {
    // Only stale-permitted catalogs keep their previous window across request failure.
    if (requestIsCurrent()) {
      live.settleRootWindows(params.catalogs(), sessionCatalogRequestError(error), acceptsHost);
      retryDelayMs = live.retryRequest(error);
      if (live.startupPending) {
        params.applyError(error);
      } else if (retryDelayMs === null) {
        live.warnRequestError(error);
        params.applyError(error);
      }
    }
  } finally {
    const ownsRequest = live.ownsRequest(requestOwner);
    const current = requestIsCurrent();
    live.endRequest(requestOwner);
    if (ownsRequest && current && params.connected()) {
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

export function hiddenSessionCatalogPages(
  catalogs: readonly SessionCatalog[],
  hiddenCatalogIds: readonly string[],
) {
  const hiddenIds = new Set(hiddenCatalogIds);
  return catalogs.flatMap((catalog) => {
    if (!hiddenIds.has(catalog.id) || catalog.error) {
      return [];
    }
    const hostIds = catalog.hosts
      .filter((host) => host.nextCursor && !host.pending && !host.error)
      .map((host) => host.hostId);
    return hostIds.length > 0 ? [{ catalogId: catalog.id, hostIds }] : [];
  });
}
