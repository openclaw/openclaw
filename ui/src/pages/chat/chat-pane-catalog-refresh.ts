import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionsCatalogReadResult } from "../../../../packages/gateway-protocol/src/index.js";
import { catalogMessageId } from "./catalog-message-id.ts";

const CATALOG_REFRESH_MAX_PAGES = 20;
const CATALOG_REFRESH_MAX_MESSAGES = 1_000;

function catalogProjectionIdentity(message: unknown): string | null {
  if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
    return null;
  }
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    return null;
  }
  const metadata = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
  try {
    return `projection:${JSON.stringify([
      message.role,
      message.content,
      typeof message.timestamp === "number" ? message.timestamp : null,
      typeof metadata?.senderId === "string" ? metadata.senderId : null,
    ])}`;
  } catch {
    return null;
  }
}

function catalogRefreshIdentity(message: unknown): string | null {
  const messageId = catalogMessageId(message);
  return messageId ? `id:${messageId}` : catalogProjectionIdentity(message);
}

/** Finds the retained boundary inside refreshed history; ID-less rows require two anchors. */
function catalogRefreshBoundary(current: unknown[], refreshed: unknown[]): number | null {
  const currentIds = current.map(catalogRefreshIdentity);
  const refreshedIds = refreshed.map(catalogRefreshIdentity);
  const firstIdentity = currentIds[0];
  if (!firstIdentity) {
    return null;
  }
  let bestBoundary: number | null = null;
  let bestLength = 0;
  let ambiguous = false;
  for (let boundary = 0; boundary < refreshed.length; boundary += 1) {
    if (refreshedIds[boundary] !== firstIdentity) {
      continue;
    }
    let length = 1;
    while (
      length < current.length &&
      boundary + length < refreshed.length &&
      refreshedIds[boundary + length] === currentIds[length]
    ) {
      length += 1;
    }
    if (length > bestLength) {
      bestLength = length;
      bestBoundary = boundary;
      ambiguous = false;
    } else if (length === bestLength) {
      ambiguous = true;
    }
  }
  const requiredLength = catalogMessageId(current[0]) ? 1 : 2;
  return !ambiguous && bestLength >= requiredLength ? bestBoundary : null;
}

/** Reads backward until the refreshed transcript reaches the oldest retained row. */
export async function loadCatalogRefreshPages(options: {
  current: unknown[];
  firstPage: SessionsCatalogReadResult;
  firstPageMessages: unknown[];
  isCurrent: () => boolean;
  project: (page: SessionsCatalogReadResult) => unknown[];
  read: (cursor: string) => Promise<SessionsCatalogReadResult>;
}): Promise<{ messages: unknown[]; nextCursor?: string } | null> {
  let page = options.firstPage;
  const messages = [...options.firstPageMessages];
  if (options.current.length === 0) {
    return { messages, nextCursor: page.nextCursor };
  }
  let pagesRead = 1;
  const seenCursors = new Set<string>();
  while (catalogRefreshBoundary(options.current, messages) === null && page.nextCursor) {
    if (
      seenCursors.has(page.nextCursor) ||
      pagesRead >= CATALOG_REFRESH_MAX_PAGES ||
      messages.length >= CATALOG_REFRESH_MAX_MESSAGES
    ) {
      return null;
    }
    seenCursors.add(page.nextCursor);
    page = await options.read(page.nextCursor);
    if (!options.isCurrent()) {
      return null;
    }
    const olderMessages = options.project(page);
    pagesRead += 1;
    if (messages.length + olderMessages.length > CATALOG_REFRESH_MAX_MESSAGES) {
      return null;
    }
    messages.unshift(...olderMessages);
  }
  return catalogRefreshBoundary(options.current, messages) !== null || !page.nextCursor
    ? { messages, nextCursor: page.nextCursor }
    : null;
}
