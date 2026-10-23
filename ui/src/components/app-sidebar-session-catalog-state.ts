import type {
  SessionCatalog,
  SessionCatalogHost,
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

export function repeatedCatalogCursorError(): NonNullable<SessionCatalog["error"]> & {
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

export function sessionCatalogRequestError(error: unknown): NonNullable<SessionCatalog["error"]> {
  return {
    code: error instanceof GatewayRequestError ? error.gatewayCode : "UNAVAILABLE",
    message: formatUiError(error),
  };
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

export function sessionCatalogPageFailed(host: Pick<SessionCatalogHost, "error">): boolean {
  // A discovery frontier is a successful partial page, including its rows and exhausted cursor.
  return host.error !== undefined && host.error.code !== "DISCOVERY_TRUNCATED";
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
  const { nextCursor, pending: _pending, error: previousError, ...previousDetails } = previous;
  return {
    ...previousDetails,
    ...freshDetails,
    ...(freshHost.pending && !freshHost.error && previousError ? { error: previousError } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export type ExpandedSessionCatalogPagesParams = {
  catalogs: SessionCatalog[];
  previousCatalogs: readonly SessionCatalog[];
  client: GatewayBrowserClient;
  agentId: string;
  pageDepths: ReadonlyMap<string, number>;
  isCurrent: (catalogId: string, hostId: string) => boolean;
  canRequestPage: (catalogId: string, hostId: string) => boolean;
};

export async function refetchExpandedSessionCatalogPages(
  params: ExpandedSessionCatalogPagesParams,
): Promise<SessionCatalog[]> {
  if (
    !params.catalogs.some(
      (catalog) =>
        catalog.hosts.some(
          (host) =>
            !host.pending &&
            (params.pageDepths.get(sessionCatalogHostKey(catalog.id, host.hostId)) ?? 0) > 0,
        ) ||
        (params.previousCatalogs.some((previous) => previous.id === catalog.id) &&
          (catalog.pending ||
            sessionCatalogPageFailed(catalog) ||
            catalog.hosts.some((host) => host.pending || sessionCatalogPageFailed(host)))),
    )
  ) {
    // The ordinary head-only read keeps exactly the same fresh-row normalization.
    return params.catalogs.map((catalog) => ({
      ...catalog,
      hosts: catalog.hosts.map((host) => preserveExpandedCatalogHost(host, undefined, catalog)),
    }));
  }
  const { refetchExpandedSessionCatalogPages: replayExpandedSessionCatalogPages } =
    await import("./app-sidebar-session-catalog-pages.runtime.ts");
  // The runtime retains canRequestPage before every RPC and isCurrent after it.
  return replayExpandedSessionCatalogPages(params);
}
