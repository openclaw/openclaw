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
): number {
  if (sortBy === "updatedAt") {
    const aPinnedAt =
      a[1]?.pinnedAt !== undefined && isPinnableSessionEntry(a[0], a[1]) ? (a[1].pinnedAt ?? 0) : 0;
    const bPinnedAt =
      b[1]?.pinnedAt !== undefined && isPinnableSessionEntry(b[0], b[1]) ? (b[1].pinnedAt ?? 0) : 0;
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
  const timestamps = new Float64Array(entries.length);
  const pins = sortBy === "updatedAt" ? new Float64Array(entries.length) : undefined;
  const indices = Array<number>(entries.length);
  for (let index = 0; index < entries.length; index++) {
    const pair = entries[index]!;
    const key = pair[0];
    const entry = pair[1];
    timestamps[index] =
      (sortBy === "activity" ? sessionActivityTimestamp(entry) : entry[sortBy]) ?? 0;
    if (pins && entry.pinnedAt !== undefined && isPinnableSessionEntry(key, entry)) {
      pins[index] = entry.pinnedAt ?? 0;
    }
    indices[index] = index;
  }
  // Typed keys avoid boxing timestamp reads and differences in the comparison loop.
  return sortAndLimitBy(indices, limit, (a, b) => {
    if (pins && pins[a] !== pins[b]) {
      return pins[b]! > pins[a]! ? 1 : -1;
    }
    if (timestamps[a] !== timestamps[b]) {
      return timestamps[b]! > timestamps[a]! ? 1 : -1;
    }
    const aKey = entries[a]![0];
    const bKey = entries[b]![0];
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  }).map((index) => entries[index]!);
}
