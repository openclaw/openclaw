// Bounded session-list ordering shared by synchronous and asynchronous projections.

import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";

export type SessionEntryPair = [string, SessionEntry];

export function compareSessionEntryPairs(
  a: SessionEntryPair,
  b: SessionEntryPair,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
  isPinnable?: (pair: SessionEntryPair) => boolean,
): number {
  if (sortBy === "updatedAt") {
    const aPinnedAt =
      a[1]?.pinnedAt !== undefined &&
      (isPinnable ? isPinnable(a) : isPinnableSessionEntry(a[0], a[1]))
        ? (a[1].pinnedAt ?? 0)
        : 0;
    const bPinnedAt =
      b[1]?.pinnedAt !== undefined &&
      (isPinnable ? isPinnable(b) : isPinnableSessionEntry(b[0], b[1]))
        ? (b[1].pinnedAt ?? 0)
        : 0;
    if (aPinnedAt !== bPinnedAt) {
      return bPinnedAt - aPinnedAt;
    }
  }
  const aTimestamp = sortBy === "activity" ? sessionActivityTimestamp(a[1]) : a[1][sortBy];
  const bTimestamp = sortBy === "activity" ? sessionActivityTimestamp(b[1]) : b[1][sortBy];
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
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): SessionEntryPair[] {
  // Prepare only if a comparison needs pins, and retire the facts with this synchronous sort.
  let pinnable: Set<SessionEntryPair> | undefined;
  const isPinnable = (pair: SessionEntryPair) => {
    if (!pinnable) {
      pinnable = new Set();
      for (const entry of entries) {
        if (entry[1].pinnedAt !== undefined && isPinnableSessionEntry(entry[0], entry[1])) {
          pinnable.add(entry);
        }
      }
    }
    return pinnable.has(pair);
  };
  return sortAndLimitBy(entries, limit, (a, b) =>
    compareSessionEntryPairs(a, b, sortBy, isPinnable),
  );
}
