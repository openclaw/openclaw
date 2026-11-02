import type {
  SessionCatalogHost,
  SessionCatalogProfileRelation,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CatalogSessionKey } from "./catalog-key.ts";

const CATALOG_SESSION_LOOKUP_PAGE_LIMIT = 100;
const CATALOG_SESSION_LOOKUP_MAX_PAGES = 100;

/** Resolves a catalog row's metadata (host + per-session capability flags).
    A sidebar row can come from any loaded page, so this follows the host's
    cursor until the thread is found; `null` means the caller went stale. */
export async function lookupCatalogSession(params: {
  client: Pick<GatewayBrowserClient, "request">;
  key: CatalogSessionKey;
  agentId: string;
  profileRelation?: SessionCatalogProfileRelation;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}) {
  const { agentId, client, key } = params;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let host: SessionCatalogHost | null = null;
  for (let pageIndex = 0; pageIndex < CATALOG_SESSION_LOOKUP_MAX_PAGES; pageIndex += 1) {
    if (params.signal?.aborted || !params.isCurrent()) {
      return null;
    }
    const listed = await client.request<SessionsCatalogListResult>(
      "sessions.catalog.list",
      {
        agentId,
        catalogId: key.catalogId,
        hostIds: [key.hostId],
        ...(params.profileRelation ? { profileRelation: params.profileRelation } : {}),
        limitPerHost: CATALOG_SESSION_LOOKUP_PAGE_LIMIT,
        ...(cursor ? { cursors: { [key.hostId]: cursor } } : {}),
      },
      { signal: params.signal },
    );
    if (params.signal?.aborted || !params.isCurrent()) {
      return null;
    }
    const catalog = listed.catalogs.find((candidate) => candidate.id === key.catalogId);
    host = catalog?.hosts.find((candidate) => candidate.hostId === key.hostId) ?? null;
    const session = host?.sessions.find((candidate) => candidate.threadId === key.threadId) ?? null;
    if (session) {
      return { host, session };
    }
    const nextCursor = host?.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { host, session: null };
}
