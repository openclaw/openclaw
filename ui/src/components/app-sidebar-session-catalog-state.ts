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

export function sessionCatalogPageFailed(host: Pick<SessionCatalogHost, "error">): boolean {
  // A discovery frontier is a successful partial page, including its rows and exhausted cursor.
  return host.error !== undefined && host.error.code !== "DISCOVERY_TRUNCATED";
}

export function preserveExpandedCatalogHost(
  freshHost: SessionCatalogHost,
  previous: SessionCatalogHost | undefined,
  requiresFreshList = false,
): SessionCatalogHost {
  if (requiresFreshList) {
    const { nextCursor: _cursor, ...details } = freshHost;
    return { ...details, sessions: [] };
  }
  if (!previous) {
    return freshHost;
  }
  const { sessions: _freshSessions, nextCursor: _freshNextCursor, ...freshDetails } = freshHost;
  const { nextCursor, pending: _pending, error: previousError, ...previousDetails } = previous;
  return {
    ...previousDetails,
    ...freshDetails,
    ...(freshHost.pending && !freshHost.error && previousError ? { error: previousError } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

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
      const previousCatalog = previousCatalogs.get(catalog.id);
      const previousHosts = new Map(
        previousCatalog?.hosts.map((host) => [host.hostId, host]) ?? [],
      );
      const catalogError = sessionCatalogPageFailed(catalog) ? catalog.error : undefined;
      // Both native catalogs use this marker when paired-node enumeration fails.
      // It cannot withdraw nodes, but successfully read local hosts remain authoritative.
      const nodeInventoryError = catalog.hosts.find(
        (host) =>
          host.kind === "node" &&
          host.hostId === "node:registry" &&
          host.error?.code === "NODE_LIST_FAILED",
      )?.error;
      const catalogHosts = new Map(catalog.hosts.map((host) => [host.hostId, host]));
      if (catalog.pending || catalogError || nodeInventoryError) {
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
        [...catalogHosts.values()].map(async (host) => {
          const pageDepth =
            params.pageDepths.get(sessionCatalogHostKey(catalog.id, host.hostId)) ?? 0;
          const previous = previousHosts.get(host.hostId);
          if (host.pending) {
            return preserveExpandedCatalogHost(host, previous, catalog.requiresFreshList);
          }
          if (sessionCatalogPageFailed(host) || sessionCatalogPageFailed(catalog)) {
            return preserveExpandedCatalogHost(
              { ...host, error: host.error ?? catalog.error },
              previous,
              catalog.requiresFreshList,
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
              catalog.requiresFreshList,
            );
          const requestedCursors = new Set<string>();
          for (let loadedPages = 0; loadedPages < pageDepth && nextCursor; loadedPages += 1) {
            // Pausing automatic replay must retain the full visible window, not its partial prefix.
            if (!params.canRequestPage()) {
              return preserveExpandedCatalogHost(
                catalog.requiresFreshList ? { ...host, pending: true } : host,
                previous,
                catalog.requiresFreshList,
              );
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
            if (!params.isCurrent()) {
              return previous ?? host;
            }
            const page = result.catalogs.find((candidate) => candidate.id === catalog.id);
            const pageHost = page?.hosts.find((candidate) => candidate.hostId === host.hostId);
            if (page && sessionCatalogPageFailed(page)) {
              return preserveOnError(page.error!);
            }
            if (pageHost?.pending || (page?.pending && !pageHost)) {
              return preserveExpandedCatalogHost(
                pageHost ?? { ...host, pending: true },
                previous ?? { ...host, sessions, nextCursor },
                catalog.requiresFreshList,
              );
            }
            if (!pageHost) {
              return preserveOnError(missingCatalogPageError());
            }
            if (sessionCatalogPageFailed(pageHost)) {
              return preserveExpandedCatalogHost(
                { ...host, ...pageHost },
                previous ?? host,
                catalog.requiresFreshList,
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
