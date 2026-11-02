import type {
  SessionCatalog,
  SessionsCatalogListParams,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  mergeCatalogSessionRows,
  missingCatalogPageError,
  preserveExpandedCatalogHost,
  repeatedCatalogCursorError,
  sessionCatalogPageFailed,
} from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";
import type { SessionCatalogDataOwner } from "./session-data-catalog.ts";

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

/** Execute an admitted incremental page; fresh-window reauthorization stays with the owner. */
export async function loadSessionCatalogPage({
  owner,
  client,
  request,
  cursors,
  discovering,
  isCurrent,
}: {
  owner: SessionCatalogDataOwner;
  client: GatewayBrowserClient;
  request: SessionsCatalogListParams & { catalogId: string };
  cursors: Record<string, string>;
  discovering: boolean;
  isCurrent: () => boolean;
}): Promise<void> {
  const catalogId = request.catalogId;
  const result = await client.request<SessionsCatalogListResult>("sessions.catalog.list", request);
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
}
