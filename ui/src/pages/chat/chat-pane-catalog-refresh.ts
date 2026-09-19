import type { SessionsCatalogReadResult } from "../../../../packages/gateway-protocol/src/index.js";
import { nativeHistoryMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { catalogMessageId } from "./catalog-message-id.ts";

function catalogRefreshIdentity(message: unknown): string | null {
  const messageId = catalogMessageId(message);
  return messageId ? `id:${messageId}` : nativeHistoryMessageIdentity(message);
}

function catalogRefreshStart(current: unknown[], refreshed: unknown[]): number | null {
  const currentIds = current.map(catalogRefreshIdentity);
  const refreshedIds = refreshed.map(catalogRefreshIdentity);
  const firstIdentity = refreshedIds[0];
  if (!firstIdentity) {
    return null;
  }
  let bestStart: number | null = null;
  let bestLength = 0;
  let ambiguous = false;
  for (let start = 0; start < current.length; start += 1) {
    if (currentIds[start] !== firstIdentity) {
      continue;
    }
    let length = 1;
    while (
      start + length < current.length &&
      length < refreshed.length &&
      refreshedIds[length] === currentIds[start + length]
    ) {
      length += 1;
    }
    if (length > bestLength) {
      bestLength = length;
      bestStart = start;
      ambiguous = false;
    } else if (length === bestLength) {
      ambiguous = true;
    }
  }
  const requiredLength = catalogMessageId(refreshed[0]) ? 1 : 2;
  return !ambiguous && bestLength >= requiredLength ? bestStart : null;
}

export async function loadCatalogRefreshPages(options: {
  current: unknown[];
  firstPage: SessionsCatalogReadResult;
  firstPageMessages: unknown[];
  isCurrent: () => boolean;
  project: (page: SessionsCatalogReadResult) => unknown[];
  read: (cursor: string) => Promise<SessionsCatalogReadResult>;
}): Promise<{ complete: boolean; messages: unknown[] } | null> {
  let page = options.firstPage;
  const messages = [...options.firstPageMessages];
  let readOlderPage = false;
  const seenCursors = new Set<string>();
  while (
    catalogRefreshStart(options.current, messages) === null &&
    page.nextCursor &&
    !seenCursors.has(page.nextCursor)
  ) {
    seenCursors.add(page.nextCursor);
    page = await options.read(page.nextCursor);
    if (!options.isCurrent()) {
      return null;
    }
    messages.unshift(...options.project(page));
    readOlderPage = true;
  }
  return { complete: readOlderPage && !page.nextCursor, messages };
}

export function reconcileCatalogRefresh(
  current: unknown[],
  refreshed: unknown[],
  previousLatestPageSize: number,
  complete: boolean,
): unknown[] {
  const refreshStart = catalogRefreshStart(current, refreshed);
  if (refreshStart !== null) {
    return [...current.slice(0, refreshStart), ...refreshed];
  }
  if (complete) {
    return refreshed;
  }
  const preservedEnd = Math.max(0, current.length - previousLatestPageSize);
  return [...current.slice(0, preservedEnd), ...refreshed];
}
