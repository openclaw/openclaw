import { vi } from "vitest";
import type { SessionCatalogTranscriptItem } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { readBoundedSessionCatalogHistory } from "./session-catalog-history-import.js";

export function catalogReader(items: SessionCatalogTranscriptItem[], maxPageSize = 50) {
  return vi.fn(async ({ cursor, limit }: { cursor?: string; limit: number }) => {
    // Both native provider parsers reject transcript pages above 50 items.
    if (limit > 50) {
      throw new Error("limit must be an integer from 1 to 50");
    }
    const end = Math.max(0, items.length - Number(cursor ?? 0));
    const start = Math.max(0, end - Math.min(limit, maxPageSize));
    return {
      hostId: "gateway",
      threadId: "source-thread",
      items: items.slice(start, end).toReversed(),
      ...(start > 0 ? { nextCursor: String(items.length - start) } : {}),
    };
  });
}

export function readHistory(
  items: SessionCatalogTranscriptItem[],
  maxItems = 50_000,
  maxBytes = 64 * 1024 * 1024,
) {
  return readBoundedSessionCatalogHistory({
    read: catalogReader(items),
    limits: { maxItems, maxBytes },
  });
}
