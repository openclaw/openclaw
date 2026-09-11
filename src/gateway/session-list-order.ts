// Bounded session-list ordering shared by synchronous and asynchronous projections.

import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";

export type SessionEntryPair = [string, SessionEntry];

function compareSessionEntryPairs(
  a: SessionEntryPair,
  b: SessionEntryPair,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): number {
  if (sortBy !== "lastInteractionAt") {
    const aPinnedAt =
      a[1]?.pinnedAt !== undefined && isPinnableSessionEntry(a[0], a[1]) ? (a[1].pinnedAt ?? 0) : 0;
    const bPinnedAt =
      b[1]?.pinnedAt !== undefined && isPinnableSessionEntry(b[0], b[1]) ? (b[1].pinnedAt ?? 0) : 0;
    if (aPinnedAt !== bPinnedAt) {
      return bPinnedAt - aPinnedAt;
    }
  }
  const aTimestamp = sortBy === "lastInteractionAt" ? a[1]?.lastInteractionAt : a[1]?.updatedAt;
  const bTimestamp = sortBy === "lastInteractionAt" ? b[1]?.lastInteractionAt : b[1]?.updatedAt;
  const byTimestamp = (bTimestamp ?? 0) - (aTimestamp ?? 0);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  // Stable key ties keep offset paging deterministic across calls.
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

export function sortAndLimitSessionEntries(
  entries: SessionEntryPair[],
  limit: number | undefined,
  sortBy: SessionsListParams["sortBy"],
): SessionEntryPair[] {
  return sortAndLimitBy(entries, limit, (a, b) => compareSessionEntryPairs(a, b, sortBy));
}
