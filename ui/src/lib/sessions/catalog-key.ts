import { normalizeAgentId } from "./session-key.ts";

export type CatalogSessionKey = {
  catalogId: string;
  hostId: string;
  threadId: string;
  sourceHomeId?: string;
};

/** Fired on `document` when a catalog session is adopted into an OpenClaw
    session, so the sidebar can bind the row to its session key immediately
    instead of waiting for the next catalog poll. */
export const CATALOG_SESSION_CONTINUED_EVENT = "openclaw-session-catalog-continued";

export type CatalogSessionContinuedDetail = CatalogSessionKey & {
  agentId: string;
  sessionKey: string;
};

export function announceCatalogSessionContinued(detail: CatalogSessionContinuedDetail): void {
  document.dispatchEvent(
    new CustomEvent<CatalogSessionContinuedDetail>(CATALOG_SESSION_CONTINUED_EVENT, { detail }),
  );
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
    ...(key.sourceHomeId ? { sourceHomeId: key.sourceHomeId } : {}),
  }).toString()}`;
}

export function catalogSessionKeyFromSearch(search: string): CatalogSessionKey | null {
  const params = new URLSearchParams(search);
  const [catalogId, hostId, threadId, sourceHomeId] = [
    "catalog",
    "host",
    "thread",
    "sourceHomeId",
  ].map((name) => params.get(name)?.trim());
  return catalogId && hostId && threadId
    ? { catalogId, hostId, threadId, ...(sourceHomeId ? { sourceHomeId } : {}) }
    : null;
}

export function parseCatalogSessionKey(value: string | null | undefined): CatalogSessionKey | null {
  // Strip only the owner prefix: native source identifiers are case-sensitive.
  const source = value?.replace(/^agent:[^:]+:/u, "");
  if (!source?.startsWith("catalog:")) {
    return null;
  }
  const parts = source.slice("catalog:".length).split(":");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const [catalogId, hostId, threadId] = parts.map((part) => decodeURIComponent(part));
    return catalogId && hostId && threadId ? { catalogId, hostId, threadId } : null;
  } catch {
    return null;
  }
}
