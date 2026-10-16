import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

export function excludeSessionCatalogRows(
  catalogs: SessionCatalog[],
  excluded: ReadonlySet<string>,
): SessionCatalog[] {
  if (excluded.size === 0) {
    return catalogs;
  }
  return catalogs.map((catalog) => ({
    ...catalog,
    hosts: catalog.hosts.map((host) => ({
      ...host,
      sessions: host.sessions.filter(
        (session) =>
          !excluded.has(
            buildCatalogSessionKey({
              catalogId: catalog.id,
              hostId: host.hostId,
              threadId: session.threadId,
            }),
          ),
      ),
    })),
  }));
}

// Local outcome identity; the Gateway error's serialized shape stays unchanged.
const repeatedCursorFailure = Symbol("repeated-catalog-cursor");

function repeatedCatalogCursorError(): NonNullable<SessionCatalog["error"]> & {
  [repeatedCursorFailure]: true;
} {
  return {
    code: "PAGINATION_FAILED",
    message: t("chat.sidebar.catalogPaginationFailed"),
    [repeatedCursorFailure]: true,
  };
}

export function isRepeatedCatalogCursorError(error: SessionCatalog["error"]): boolean {
  return error !== undefined && repeatedCursorFailure in error;
}

function missingCatalogPageError(): NonNullable<SessionCatalog["error"]> {
  return { code: "PAGINATION_FAILED", message: t("chat.sidebar.catalogPageMissingHost") };
}

export function sessionCatalogRequestError(error: unknown): NonNullable<SessionCatalog["error"]> {
  return {
    code: error instanceof GatewayRequestError ? error.gatewayCode : "UNAVAILABLE",
    message: formatUiError(error),
  };
}

function mergeCatalogSessionRows(
  first: readonly SessionCatalogSession[],
  second: readonly SessionCatalogSession[],
): SessionCatalogSession[] {
  const seen = new Set(first.map((session) => session.threadId));
  return [...first, ...second.filter((session) => !seen.has(session.threadId))];
}

/** Fresh-required rows and cursors cannot authorize a later request. */
export function withdrawSessionCatalogRows(
  catalog: SessionCatalog,
  hostIds?: readonly string[],
): SessionCatalog {
  if (!catalog.requiresFreshList) {
    return catalog;
  }
  return {
    ...catalog,
    hosts: catalog.hosts.map((host) =>
      !hostIds || hostIds.includes(host.hostId)
        ? { ...host, sessions: [], nextCursor: undefined }
        : host,
    ),
  };
}

export function preserveExpandedCatalogHost(
  freshHost: SessionCatalogHost,
  previous: SessionCatalogHost | undefined,
  catalog: SessionCatalog,
): SessionCatalogHost {
  if (catalog.requiresFreshList) {
    if (catalog.error || freshHost.error || freshHost.pending) {
      const { nextCursor: _cursor, ...host } = freshHost;
      return { ...host, sessions: [] };
    }
    return freshHost;
  }
  if (!previous) {
    return freshHost;
  }
  const { sessions: _freshSessions, nextCursor: _freshNextCursor, ...freshDetails } = freshHost;
  const { nextCursor, pending: _pending, ...previousDetails } = previous;
  return {
    ...previousDetails,
    ...freshDetails,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export function mergeSessionCatalogPage(params: {
  current: SessionCatalog;
  page: SessionCatalog | undefined;
  cursors: Readonly<Record<string, string>>;
  previousCursors?: ReadonlyMap<string, ReadonlySet<string>>;
  freshHostIds?: readonly string[];
}): { catalog: SessionCatalog; advancedHostIds: string[]; repeatedHostIds: string[] } {
  const { page } = params;
  if (params.freshHostIds && (!page || page.error)) {
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
  if (!page) {
    return {
      catalog: { ...params.current, error: missingCatalogPageError() },
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
    if (
      page.error ||
      (!freshRequest && (requestedCursor === undefined || host.nextCursor !== requestedCursor))
    ) {
      return host;
    }
    if (!pageHost) {
      return { ...host, error: missingCatalogPageError() };
    }
    if (pageHost.error || (freshRequest && pageHost.pending)) {
      return preserveExpandedCatalogHost(pageHost, host, page);
    }
    const { nextCursor, sessions, error: _pageError, ...pageHostDetails } = pageHost;
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
  const { hosts: _currentHosts, error: _currentError, ...currentDetails } = params.current;
  const { hosts: _pageHosts, error: pageError, ...pageDetails } = page;
  return {
    catalog: {
      ...currentDetails,
      ...pageDetails,
      hosts,
      // A targeted success cannot settle a concurrent root discovery failure.
      ...(pageError || (params.freshHostIds && params.current.error)
        ? { error: pageError ?? params.current.error }
        : {}),
    },
    advancedHostIds,
    repeatedHostIds,
  };
}

export async function refetchExpandedSessionCatalogPages(params: {
  catalogs: SessionCatalog[];
  previousCatalogs: readonly SessionCatalog[];
  client: GatewayBrowserClient;
  agentId: string;
  pageDepths: ReadonlyMap<string, number>;
  isCurrent: (catalogId: string, hostId: string) => boolean;
  canRequestPage: (catalogId: string, hostId: string) => boolean;
}): Promise<SessionCatalog[]> {
  const previousCatalogs = new Map(params.previousCatalogs.map((catalog) => [catalog.id, catalog]));
  return Promise.all(
    params.catalogs.map(async (catalog) => {
      const previousHosts = new Map(
        previousCatalogs.get(catalog.id)?.hosts.map((host) => [host.hostId, host]) ?? [],
      );
      const hosts = await Promise.all(
        catalog.hosts.map(async (incomingHost) => {
          const host = preserveExpandedCatalogHost(incomingHost, undefined, catalog);
          const pageDepth =
            params.pageDepths.get(sessionCatalogHostKey(catalog.id, host.hostId)) ?? 0;
          if (pageDepth === 0 || host.pending) {
            return host;
          }
          const previous = previousHosts.get(host.hostId);
          if (host.error || catalog.error) {
            return preserveExpandedCatalogHost(
              { ...host, error: host.error ?? catalog.error },
              previous,
              catalog,
            );
          }
          let sessions = host.sessions;
          let nextCursor = host.nextCursor;
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
              return catalog.requiresFreshList ? { ...host, sessions: [] } : (previous ?? host);
            }
            const page = result.catalogs.find((candidate) => candidate.id === catalog.id);
            const pageHost = page?.hosts.find((candidate) => candidate.hostId === host.hostId);
            if (page?.error) {
              return preserveOnError(page.error);
            }
            if (!pageHost) {
              return preserveOnError(missingCatalogPageError());
            }
            if (pageHost.error || pageHost.pending) {
              return preserveExpandedCatalogHost(
                { ...host, ...pageHost },
                previous ?? host,
                catalog,
              );
            }
            sessions = mergeCatalogSessionRows(sessions, pageHost.sessions);
            nextCursor = pageHost.nextCursor;
            if (nextCursor && requestedCursors.has(nextCursor)) {
              return preserveOnError(repeatedCatalogCursorError());
            }
          }
          const { nextCursor: _cursor, sessions: _sessions, ...freshHost } = host;
          return { ...freshHost, sessions, ...(nextCursor ? { nextCursor } : {}) };
        }),
      );
      return { ...catalog, hosts };
    }),
  );
}
