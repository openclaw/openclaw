import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";

const MAX_SESSION_LIST_PASSES = 4;

export async function fetchPagedSessionRows(params: {
  list: (offset: number) => Promise<SessionsListResult | null>;
  initialResult?: SessionsListResult | null;
  resultKind?: "page" | "window";
  /** Pagination receipt captured with the displayed managed-window result. */
  windowPagination?: () =>
    | (Pick<SessionsListResult, "totalCount" | "hasMore" | "nextOffset"> & { count: number })
    | undefined;
  isCurrent?: () => boolean;
  mapPageRows?: (rows: GatewaySessionRow[]) => GatewaySessionRow[];
  missingResultError: string;
  stalledPaginationError?: string;
  incompletePaginationError?: string;
}): Promise<GatewaySessionRow[] | null> {
  if (params.initialResult === null) {
    return [];
  }
  const rowsByKey = new Map<string, GatewaySessionRow>();
  let expectedTotal: number | undefined;
  let receivedCount = 0;
  for (let pass = 0; pass < MAX_SESSION_LIST_PASSES; pass += 1) {
    // Include prefetched rows in first-pass progress so a moving row triggers a retry.
    const rowsBeforePass = rowsByKey.size;
    const seenOffsets = new Set<number>();
    let offset = 0;
    let prefetched = pass === 0 ? params.initialResult : undefined;
    while (!seenOffsets.has(offset)) {
      seenOffsets.add(offset);
      const result = prefetched ?? (await params.list(offset));
      prefetched = undefined;
      if (params.isCurrent && !params.isCurrent()) {
        return null;
      }
      if (!result) {
        throw new Error(params.missingResultError);
      }
      const pagination = params.resultKind === "window" ? params.windowPagination?.() : undefined;
      const totalCount = pagination?.totalCount ?? result.totalCount;
      if (params.resultKind === "window") {
        // Managed pagination already owns accumulated membership. A replacement
        // must retire old rows instead of completing against a cross-pass union.
        rowsByKey.clear();
        expectedTotal = totalCount;
      }
      // Optional later-page counts must never erase a known larger roster.
      if (typeof totalCount === "number") {
        expectedTotal = Math.max(expectedTotal ?? 0, totalCount);
      }
      const rows = params.mapPageRows?.(result.sessions) ?? result.sessions;
      for (const row of rows) {
        rowsByKey.set(row.key, row);
      }
      receivedCount = pagination?.count ?? rowsByKey.size;
      const hasMore =
        pagination?.hasMore ??
        result.hasMore ??
        (typeof result.totalCount === "number" &&
          offset + result.sessions.length < result.totalCount);
      if (!hasMore) {
        break;
      }
      const nextOffset =
        pagination?.nextOffset ??
        result.nextOffset ??
        (result.offset ?? offset) + result.sessions.length;
      if (nextOffset <= offset) {
        if (params.stalledPaginationError) {
          throw new Error(params.stalledPaginationError);
        }
        break;
      }
      offset = nextOffset;
    }
    if (
      (params.resultKind !== "window" && rowsByKey.size === rowsBeforePass) ||
      expectedTotal === undefined ||
      receivedCount >= expectedTotal
    ) {
      break;
    }
    // Gateway updatedAt sorting can move rows across offset windows between RPCs.
  }
  if (
    params.incompletePaginationError &&
    expectedTotal !== undefined &&
    receivedCount < expectedTotal
  ) {
    throw new Error(params.incompletePaginationError);
  }
  return [...rowsByKey.values()];
}
