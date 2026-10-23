import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionsCatalogListResult,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import { t } from "../i18n/index.ts";
import {
  type ExpandedSessionCatalogPagesParams,
  preserveExpandedCatalogHost,
  sessionCatalogPageFailed,
  sessionCatalogRequestError,
  repeatedCatalogCursorError,
} from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";
import type { SessionCatalogDataOwner } from "./session-data-catalog.ts";

function catalogPageFailed(
  host: Pick<SessionCatalogHost, "error">,
  catalog: SessionCatalog,
): boolean {
  return (
    (catalog.requiresFreshList === true && host.error !== undefined) ||
    sessionCatalogPageFailed(host)
  );
}

function missingCatalogPageError(): NonNullable<SessionCatalog["error"]> {
  return { code: "PAGINATION_FAILED", message: t("chat.sidebar.catalogPageMissingHost") };
}

function mergeCatalogSessionRows(
  first: readonly SessionCatalogSession[],
  second: readonly SessionCatalogSession[],
): SessionCatalogSession[] {
  const seen = new Set(first.map((session) => session.threadId));
  return [...first, ...second.filter((session) => !seen.has(session.threadId))];
}

export function mergeSessionCatalogPage(params: {
  current: SessionCatalog;
  page: SessionCatalog | undefined;
  cursors: Readonly<Record<string, string>>;
  previousCursors?: ReadonlyMap<string, ReadonlySet<string>>;
  freshHostIds?: readonly string[];
}): { catalog: SessionCatalog; advancedHostIds: string[]; repeatedHostIds: string[] } {
  const page = params.page ?? {
    ...params.current,
    pending: undefined,
    hosts: [],
    error: missingCatalogPageError(),
  };
  if (params.freshHostIds && page.error) {
    const current = params.current;
    const error = page?.error ?? missingCatalogPageError();
    return {
      catalog: {
        ...current,
        hosts: current.hosts.map((host) =>
          params.freshHostIds!.includes(host.hostId)
            ? preserveExpandedCatalogHost({ ...host, error }, undefined, current)
            : host,
        ),
      },
      advancedHostIds: [],
      repeatedHostIds: [],
    };
  }
  const pageHosts = new Map(page.hosts.map((host) => [host.hostId, host]));
  const advancedHostIds: string[] = [];
  const repeatedHostIds: string[] = [];
  const hosts = params.current.hosts.map((host) => {
    const requestedCursor = params.cursors[host.hostId];
    const pageHost = pageHosts.get(host.hostId);
    const freshRequest = params.freshHostIds?.includes(host.hostId) === true;
    if (!freshRequest && (requestedCursor === undefined || host.nextCursor !== requestedCursor)) {
      return host;
    }
    if (catalogPageFailed(page, page)) {
      if (page.pending) {
        return { ...host, pending: true };
      }
      const { pending: _pending, ...settledHost } = host;
      return settledHost;
    }
    if (!pageHost) {
      if (page.pending) {
        return preserveExpandedCatalogHost({ ...host, pending: true }, host, page);
      }
      const { pending: _pending, ...settledHost } = host;
      return { ...settledHost, error: missingCatalogPageError() };
    }
    if (pageHost.pending || catalogPageFailed(pageHost, page)) {
      return preserveExpandedCatalogHost(pageHost, host, page);
    }
    const { nextCursor, sessions, ...pageHostDetails } = pageHost;
    // A fresh window was cycle-checked by its replay. Retired cursors do not
    // identify the current authorized request, even when their strings match.
    const repeatedCursor =
      !freshRequest &&
      ((nextCursor !== undefined && nextCursor === requestedCursor) ||
        (nextCursor !== undefined && params.previousCursors?.get(host.hostId)?.has(nextCursor)));
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
      sessions: freshRequest ? sessions : mergeCatalogSessionRows(host.sessions, sessions),
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
      // A targeted success cannot settle a concurrent root discovery failure.
      ...(pageError || ((params.freshHostIds || page.pending) && currentError)
        ? { error: pageError ?? currentError }
        : {}),
    },
    advancedHostIds,
    repeatedHostIds,
  };
}

/** Publish synchronously after the caller rechecks admission at the runtime boundary. */
export function publishSessionCatalogPage({
  owner,
  catalog,
  page,
  cursors,
  requestedHostIds,
  pageDepths,
  discovering,
}: {
  owner: SessionCatalogDataOwner;
  catalog: SessionCatalog;
  page: SessionCatalog | undefined;
  cursors: Readonly<Record<string, string>>;
  requestedHostIds: readonly string[];
  pageDepths: ReadonlyMap<string, number>;
  discovering: boolean;
}): void {
  const catalogId = catalog.id;
  const live = owner.sessionCatalogLive;
  const discoveryPages = live.discoveryPages;
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
}

/** A retired replay must also stop the caller's hidden-page discovery. */
export async function replayPublishedSessionCatalogHost({
  owner,
  catalog,
  host,
  client,
  agentId,
  pageDepths,
  isCurrent,
}: Pick<ExpandedSessionCatalogPagesParams, "client" | "agentId" | "pageDepths"> & {
  owner: SessionCatalogDataOwner;
  catalog: SessionCatalog;
  host: SessionCatalogHost;
  isCurrent: () => boolean;
}): Promise<boolean> {
  const catalogId = catalog.id;
  const hostId = host.hostId;
  const [page] = await refetchExpandedSessionCatalogPages({
    catalogs: [{ ...catalog, hosts: [host] }],
    previousCatalogs: [],
    client,
    agentId,
    pageDepths,
    isCurrent,
    canRequestPage: () => isCurrent() && document.visibilityState !== "hidden",
  });
  if (!isCurrent()) {
    return false;
  }
  // Only this host was replayed. Read current state after the await so sibling
  // publications accepted while loading or fetching pages survive the merge.
  owner.sessionCatalogs = owner.sessionCatalogs.map((current) =>
    current.id === catalogId
      ? {
          ...current,
          hosts: current.hosts.map((entry) => (entry.hostId === hostId ? page!.hosts[0]! : entry)),
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
  return true;
}

/** The expanded-window replay runs only after a catalog owns an expanded page. */
export async function refetchExpandedSessionCatalogPages(
  params: ExpandedSessionCatalogPagesParams,
): Promise<SessionCatalog[]> {
  const previousCatalogs = new Map(params.previousCatalogs.map((catalog) => [catalog.id, catalog]));
  return Promise.all(
    params.catalogs.map(async (catalog) => {
      const previousCatalog = previousCatalogs.get(catalog.id);
      const previousHosts = new Map(
        previousCatalog?.hosts.map((host) => [host.hostId, host]) ?? [],
      );
      const catalogError = catalogPageFailed(catalog, catalog) ? catalog.error : undefined;
      // Failed node inventory cannot withdraw ordinary cached nodes. A fresh-required
      // source publication never borrows authority from its previous snapshot.
      const nodeInventoryError = catalog.hosts.find(
        (host) =>
          host.kind === "node" &&
          host.hostId === "node:registry" &&
          host.error?.code === "NODE_LIST_FAILED",
      )?.error;
      const catalogHosts = new Map(catalog.hosts.map((host) => [host.hostId, host]));
      if (!catalog.requiresFreshList && (catalog.pending || catalogError || nodeInventoryError)) {
        for (const host of previousHosts.values()) {
          const error = catalogError ?? (host.kind === "node" ? nodeInventoryError : undefined);
          if (catalogHosts.has(host.hostId) || (!catalog.pending && !error)) {
            continue;
          }
          const { pending: _pending, ...previousHost } = host;
          catalogHosts.set(host.hostId, {
            ...previousHost,
            ...(catalog.pending ? { pending: true } : {}),
            ...(error ? { error } : {}),
          });
        }
      }
      const hosts = await Promise.all(
        [...catalogHosts.values()].map(async (incomingHost) => {
          const host = preserveExpandedCatalogHost(incomingHost, undefined, catalog);
          const pageDepth =
            params.pageDepths.get(sessionCatalogHostKey(catalog.id, host.hostId)) ?? 0;
          const previous = previousHosts.get(host.hostId);
          if (host.pending) {
            return preserveExpandedCatalogHost(host, previous, catalog);
          }
          if (catalogPageFailed(host, catalog) || catalogPageFailed(catalog, catalog)) {
            return preserveExpandedCatalogHost(
              { ...host, error: host.error ?? catalog.error },
              previous,
              catalog,
            );
          }
          if (pageDepth === 0) {
            return host;
          }
          let sessions = host.sessions;
          let nextCursor = host.nextCursor;
          let pageError = host.error;
          const preserveOnError = (error: NonNullable<SessionCatalog["error"]>) =>
            preserveExpandedCatalogHost(
              { ...host, error },
              previous ?? { ...host, sessions, nextCursor },
              catalog,
            );
          const requestedCursors = new Set<string>();
          for (let loadedPages = 0; loadedPages < pageDepth && nextCursor; loadedPages += 1) {
            // Ordinary catalogs retain the expanded window on pause; fresh-required
            // catalogs can keep only the head authorized in this cycle.
            if (!params.canRequestPage(catalog.id, host.hostId)) {
              return preserveExpandedCatalogHost(host, previous, catalog);
            }
            requestedCursors.add(nextCursor);
            let result: SessionsCatalogListResult;
            try {
              result = await params.client.request<SessionsCatalogListResult>(
                "sessions.catalog.list",
                {
                  agentId: params.agentId,
                  catalogId: catalog.id,
                  hostIds: [host.hostId],
                  cursors: { [host.hostId]: nextCursor },
                },
              );
            } catch (error) {
              return preserveOnError(sessionCatalogRequestError(error));
            }
            if (!params.isCurrent(catalog.id, host.hostId)) {
              return catalog.requiresFreshList
                ? Object.assign({}, host, { sessions: [] })
                : (previous ?? host);
            }
            const page = result.catalogs.find((candidate) => candidate.id === catalog.id);
            const pageHost = page?.hosts.find((candidate) => candidate.hostId === host.hostId);
            if (page && catalogPageFailed(page, page)) {
              return preserveOnError(page.error!);
            }
            if (pageHost?.pending || (page?.pending && !pageHost)) {
              return preserveExpandedCatalogHost(
                pageHost ?? { ...host, pending: true },
                previous ?? { ...host, sessions, nextCursor },
                catalog,
              );
            }
            if (!pageHost) {
              return preserveOnError(missingCatalogPageError());
            }
            if (catalogPageFailed(pageHost, page!)) {
              return preserveExpandedCatalogHost(
                { ...host, ...pageHost },
                previous ?? host,
                catalog,
              );
            }
            sessions = mergeCatalogSessionRows(sessions, pageHost.sessions);
            nextCursor = pageHost.nextCursor;
            pageError = pageHost.error ?? page?.error;
            if (nextCursor && requestedCursors.has(nextCursor)) {
              return preserveOnError(repeatedCatalogCursorError());
            }
          }
          const { nextCursor: _cursor, sessions: _sessions, error: _error, ...freshHost } = host;
          return Object.assign(
            freshHost,
            { sessions },
            nextCursor ? { nextCursor } : {},
            pageError ? { error: pageError } : {},
          );
        }),
      );
      return {
        ...catalog,
        hosts,
        ...(catalog.pending && !catalog.error && previousCatalog?.error
          ? { error: previousCatalog.error }
          : {}),
      };
    }),
  );
}
