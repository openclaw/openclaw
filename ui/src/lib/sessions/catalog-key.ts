import type {
  SessionCatalogHost,
  SessionCatalogSession,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeAgentId } from "./session-key.ts";

export type CatalogSessionKey = {
  catalogId: string;
  hostId: string;
  threadId: string;
};

/** Fired on `document` when a catalog session is adopted into an OpenClaw
    session, so the sidebar can bind the row to its session key immediately
    instead of waiting for the next catalog poll. */
export const CATALOG_SESSION_CONTINUED_EVENT = "openclaw-session-catalog-continued";

export type CatalogSessionContinuedDetail = CatalogSessionKey & {
  agentId: string;
  sessionKey: string;
};

/** A catalog-backed terminal writer exited, so retained readers should reconcile
    after the Gateway's short list-sharing window has elapsed. */
export const CATALOG_SESSION_RELEASED_EVENT = "openclaw-session-catalog-released";
// The 33-second cumulative retry crosses Codex's 32-second list cache; later
// reads observe the background refresh returned stale by the expiry read.
export const CATALOG_SESSION_RELEASE_RECONCILE_DELAYS_MS = [5_000, 28_000, 1_000, 2_000, 4_000];

export type CatalogSessionReleasedDetail = Omit<CatalogSessionKey, "threadId"> & {
  agentId: string;
  threadId?: string;
};

export function announceCatalogSessionContinued(detail: CatalogSessionContinuedDetail): void {
  document.dispatchEvent(
    new CustomEvent<CatalogSessionContinuedDetail>(CATALOG_SESSION_CONTINUED_EVENT, { detail }),
  );
}

export function announceCatalogSessionReleased(detail: CatalogSessionReleasedDetail): void {
  document.dispatchEvent(
    new CustomEvent<CatalogSessionReleasedDetail>(CATALOG_SESSION_RELEASED_EVENT, { detail }),
  );
}

export function catalogSessionReleasedDetailFromEvent(
  event: Event,
): CatalogSessionReleasedDetail | null {
  const value: unknown = event instanceof CustomEvent ? event.detail : undefined;
  const threadId =
    value && typeof value === "object" && "threadId" in value ? value.threadId : null;
  if (
    value === null ||
    typeof value !== "object" ||
    !("agentId" in value) ||
    typeof value.agentId !== "string" ||
    !("catalogId" in value) ||
    typeof value.catalogId !== "string" ||
    !("hostId" in value) ||
    typeof value.hostId !== "string" ||
    (threadId !== null && typeof threadId !== "string")
  ) {
    return null;
  }
  return {
    agentId: value.agentId,
    catalogId: value.catalogId,
    hostId: value.hostId,
    ...(typeof threadId === "string" ? { threadId } : {}),
  };
}

const CATALOG_SESSION_LOOKUP_PAGE_LIMIT = 100;
const CATALOG_SESSION_LOOKUP_MAX_PAGES = 100;

type CatalogSessionLookup = {
  host: SessionCatalogHost | null;
  session: SessionCatalogSession | null;
};

/** Resolves a catalog row's metadata (host + per-session capability flags).
    A sidebar row can come from any loaded page, so this follows the host's
    cursor until the thread is found; `null` means the caller went stale. */
export async function lookupCatalogSession(params: {
  client: Pick<GatewayBrowserClient, "request">;
  key: CatalogSessionKey;
  agentId: string;
  isCurrent: () => boolean;
}): Promise<CatalogSessionLookup | null> {
  const { agentId, client, key } = params;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let host: SessionCatalogHost | null = null;
  for (let pageIndex = 0; pageIndex < CATALOG_SESSION_LOOKUP_MAX_PAGES; pageIndex += 1) {
    const listed = await client.request<SessionsCatalogListResult>("sessions.catalog.list", {
      agentId,
      catalogId: key.catalogId,
      hostIds: [key.hostId],
      limitPerHost: CATALOG_SESSION_LOOKUP_PAGE_LIMIT,
      ...(cursor ? { cursors: { [key.hostId]: cursor } } : {}),
    });
    if (!params.isCurrent()) {
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

export function buildCatalogSessionKey(key: CatalogSessionKey, agentId?: string): string {
  const source = `catalog:${encodeURIComponent(key.catalogId)}:${encodeURIComponent(key.hostId)}:${encodeURIComponent(key.threadId)}`;
  // Source rows are ownerless; routed panes carry the agent through retention and split focus.
  return agentId ? `agent:${normalizeAgentId(agentId)}:${source}` : source;
}

export function catalogSessionSearch(key: CatalogSessionKey): string {
  return `?${new URLSearchParams({
    catalog: key.catalogId,
    host: key.hostId,
    thread: key.threadId,
  }).toString()}`;
}

export function catalogSessionKeyFromSearch(search: string): CatalogSessionKey | null {
  const params = new URLSearchParams(search);
  const catalogId = params.get("catalog")?.trim() ?? "";
  const hostId = params.get("host")?.trim() ?? "";
  const threadId = params.get("thread")?.trim() ?? "";
  return catalogId && hostId && threadId ? { catalogId, hostId, threadId } : null;
}

export function parseCatalogSessionKey(value: string | null | undefined): CatalogSessionKey | null {
  // Strip only the owner prefix: native source identifiers are case-sensitive.
  const source = value?.replace(/^agent:[^:]+:/u, "");
  if (!source?.startsWith("catalog:")) {
    return null;
  }
  const parts = source.slice("catalog:".length).split(":");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return null;
  }
  try {
    const [catalogId, hostId, threadId] = parts.map((part) => decodeURIComponent(part));
    return catalogId && hostId && threadId ? { catalogId, hostId, threadId } : null;
  } catch {
    return null;
  }
}
