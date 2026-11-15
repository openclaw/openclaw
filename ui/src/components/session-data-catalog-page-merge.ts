import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import {
  mergeCatalogSessionRows,
  missingCatalogPageError,
  preserveExpandedCatalogHost,
  repeatedCatalogCursorError,
  sessionCatalogPageFailed,
} from "./app-sidebar-session-catalog-state.ts";

export function mergeSessionCatalogPage(params: {
  current: SessionCatalog;
  page: SessionCatalog | undefined;
  cursors: Readonly<Record<string, string>>;
  previousCursors?: ReadonlyMap<string, ReadonlySet<string>>;
}): { catalog: SessionCatalog; advancedHostIds: string[]; repeatedHostIds: string[] } {
  const page = params.page ?? {
    ...params.current,
    pending: undefined,
    hosts: [],
    error: missingCatalogPageError(),
  };
  const pageHosts = new Map(page.hosts.map((host) => [host.hostId, host]));
  const advancedHostIds: string[] = [];
  const repeatedHostIds: string[] = [];
  const hosts = params.current.hosts.map((host) => {
    const requestedCursor = params.cursors[host.hostId];
    const pageHost = pageHosts.get(host.hostId);
    if (requestedCursor === undefined || host.nextCursor !== requestedCursor) {
      return host;
    }
    if (sessionCatalogPageFailed(page)) {
      if (page.pending) {
        return { ...host, pending: true };
      }
      const { pending: _pending, ...settledHost } = host;
      return settledHost;
    }
    if (!pageHost) {
      if (page.pending) {
        return { ...host, pending: true };
      }
      const { pending: _pending, ...settledHost } = host;
      return { ...settledHost, error: missingCatalogPageError() };
    }
    if (pageHost.pending || sessionCatalogPageFailed(pageHost)) {
      return preserveExpandedCatalogHost(pageHost, host);
    }
    const { nextCursor, sessions, ...pageHostDetails } = pageHost;
    const repeatedCursor =
      nextCursor === requestedCursor ||
      (nextCursor !== undefined && params.previousCursors?.get(host.hostId)?.has(nextCursor));
    if (repeatedCursor) {
      repeatedHostIds.push(host.hostId);
    } else {
      advancedHostIds.push(host.hostId);
    }
    const {
      nextCursor: _currentCursor,
      error: _currentError,
      pending: _pending,
      ...currentHost
    } = host;
    return {
      ...currentHost,
      ...pageHostDetails,
      sessions: mergeCatalogSessionRows(host.sessions, sessions),
      ...(nextCursor ? { nextCursor } : {}),
      ...(repeatedCursor ? { error: repeatedCatalogCursorError() } : {}),
    };
  });
  const {
    hosts: _currentHosts,
    error: currentError,
    pending: _currentPending,
    ...currentDetails
  } = params.current;
  const { hosts: _pageHosts, error: pageError, ...pageDetails } = page;
  return {
    catalog: {
      ...currentDetails,
      ...pageDetails,
      hosts,
      ...(pageError || (page.pending && currentError) ? { error: pageError ?? currentError } : {}),
    },
    advancedHostIds,
    repeatedHostIds,
  };
}
