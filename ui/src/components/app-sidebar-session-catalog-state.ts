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

function repeatedCatalogCursorError(): NonNullable<SessionCatalog["error"]> {
  return { code: "PAGINATION_FAILED", message: t("chat.sidebar.catalogPaginationFailed") };
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

function hasUsableCatalogPage(host: SessionCatalogHost): boolean {
  return (
    !host.error ||
    (host.error.code === "LOCAL_CATALOG_PARTIAL" &&
      (host.sessions.length > 0 || host.nextCursor !== undefined))
  );
}

export function preserveExpandedCatalogHost(
  freshHost: SessionCatalogHost,
  previous: SessionCatalogHost | undefined,
): SessionCatalogHost {
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
}): { catalog: SessionCatalog; advancedHostIds: string[]; repeatedHostIds: string[] } {
  const { page } = params;
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
    if (page.error || requestedCursor === undefined || host.nextCursor !== requestedCursor) {
      return host;
    }
    if (!pageHost) {
      return { ...host, error: missingCatalogPageError() };
    }
    if (!hasUsableCatalogPage(pageHost)) {
      return preserveExpandedCatalogHost(pageHost, host);
    }
    const { nextCursor, sessions, error: _pageError, ...pageHostDetails } = pageHost;
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
    const retainedError =
      pageHost.error ?? (host.error?.code === "LOCAL_CATALOG_PARTIAL" ? host.error : undefined);
    return {
      ...currentHost,
      ...pageHostDetails,
      sessions: mergeCatalogSessionRows(host.sessions, sessions),
      ...(retainedError ? { error: retainedError } : {}),
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
      ...(pageError ? { error: pageError } : {}),
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
  isCurrent: () => boolean;
  canRequestPage: () => boolean;
}): Promise<SessionCatalog[]> {
  const previousCatalogs = new Map(params.previousCatalogs.map((catalog) => [catalog.id, catalog]));
  return Promise.all(
    params.catalogs.map(async (catalog) => {
      const previousHosts = new Map(
        previousCatalogs.get(catalog.id)?.hosts.map((host) => [host.hostId, host]) ?? [],
      );
      const hosts = await Promise.all(
        catalog.hosts.map(async (host) => {
          const pageDepth =
            params.pageDepths.get(sessionCatalogHostKey(catalog.id, host.hostId)) ?? 0;
          if (pageDepth === 0 || host.pending) {
            return host;
          }
          const previous = previousHosts.get(host.hostId);
          if (catalog.error || !hasUsableCatalogPage(host)) {
            return preserveExpandedCatalogHost(
              { ...host, error: host.error ?? catalog.error },
              previous,
            );
          }
          let sessions = host.sessions;
          let nextCursor = host.nextCursor;
          const requestedCursors = new Set<string>();
          let hostError = host.error;
          for (let loadedPages = 0; loadedPages < pageDepth && nextCursor; loadedPages += 1) {
            // Pausing automatic replay must retain the full visible window, not its partial prefix.
            if (!params.canRequestPage()) {
              return preserveExpandedCatalogHost(host, previous);
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
              return preserveExpandedCatalogHost(
                { ...host, error: sessionCatalogRequestError(error) },
                previous ?? { ...host, sessions, nextCursor },
              );
            }
            if (!params.isCurrent()) {
              return previous ?? host;
            }
            const page = result.catalogs.find((candidate) => candidate.id === catalog.id);
            const pageHost = page?.hosts.find((candidate) => candidate.hostId === host.hostId);
            if (page?.error) {
              return preserveExpandedCatalogHost(
                { ...host, error: page.error },
                previous ?? { ...host, sessions, nextCursor },
              );
            }
            if (!pageHost) {
              return preserveExpandedCatalogHost(
                {
                  ...host,
                  error: missingCatalogPageError(),
                },
                previous ?? { ...host, sessions, nextCursor },
              );
            }
            if (!hasUsableCatalogPage(pageHost)) {
              return preserveExpandedCatalogHost({ ...host, ...pageHost }, previous ?? host);
            }
            sessions = mergeCatalogSessionRows(sessions, pageHost.sessions);
            nextCursor = pageHost.nextCursor;
            if (nextCursor && requestedCursors.has(nextCursor)) {
              return preserveExpandedCatalogHost(
                { ...host, error: repeatedCatalogCursorError() },
                previous ?? { ...host, sessions, nextCursor },
              );
            }
            if (pageHost.error) {
              hostError = pageHost.error;
            }
          }
          const { nextCursor: _cursor, sessions: _sessions, ...freshHost } = host;
          return {
            ...freshHost,
            sessions,
            ...(nextCursor ? { nextCursor } : {}),
            ...(hostError ? { error: hostError } : {}),
          };
        }),
      );
      return { ...catalog, hosts };
    }),
  );
}
