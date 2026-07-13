export type CatalogSessionKey = {
  catalogId: string;
  hostId: string;
  threadId: string;
};

/** Fired on `document` when a catalog session is adopted into an OpenClaw
    session, so the sidebar can bind the row to its session key immediately
    instead of waiting for the next catalog poll. */
export const CATALOG_SESSION_CONTINUED_EVENT = "openclaw-session-catalog-continued";

export type CatalogSessionContinuedDetail = CatalogSessionKey & { sessionKey: string };

export function buildCatalogSessionKey(key: CatalogSessionKey): string {
  return `catalog:${encodeURIComponent(key.catalogId)}:${encodeURIComponent(key.hostId)}:${encodeURIComponent(key.threadId)}`;
}

export function parseCatalogSessionKey(value: string | null | undefined): CatalogSessionKey | null {
  if (!value?.startsWith("catalog:")) {
    return null;
  }
  const parts = value.slice("catalog:".length).split(":");
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
