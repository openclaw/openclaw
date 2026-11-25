// Bounded session-list ordering shared by synchronous and asynchronous projections.

import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";

export type SessionEntryPair = [string, SessionEntry];

function sessionEntryPin([key, entry]: SessionEntryPair): number {
  return entry.pinnedAt !== undefined && isPinnableSessionEntry(key, entry) ? entry.pinnedAt : 0;
}

function sessionEntryTime(entry: SessionEntry, sortBy: NonNullable<SessionsListParams["sortBy"]>) {
  return (sortBy === "activity" ? sessionActivityTimestamp(entry) : entry[sortBy]) ?? 0;
}

export function compareSessionEntryPairs(
  a: SessionEntryPair,
  b: SessionEntryPair,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): number {
  if (sortBy === "updatedAt") {
    const aPinnedAt = sessionEntryPin(a);
    const bPinnedAt = sessionEntryPin(b);
    if (aPinnedAt !== bPinnedAt) {
      return bPinnedAt - aPinnedAt;
    }
  }
  const byTimestamp = sessionEntryTime(b[1], sortBy) - sessionEntryTime(a[1], sortBy);
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
    timestamps[index] = sessionEntryTime(pair[1], sortBy);
    if (pins) {
      pins[index] = sessionEntryPin(pair);
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

/** Partition pages are disjoint and ordered; read only the heads needed by this page. */
export function mergeSessionEntryPages(
  pages: SessionEntryPair[][],
  limit: number | undefined,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): SessionEntryPair[] {
  if (limit === 0) {
    return [];
  }
  const heads = pages
    .filter((page) => page.length)
    .map((page) => {
      const pair = page[0]!;
      return {
        page,
        index: 0,
        pair,
        pin: sortBy === "updatedAt" ? sessionEntryPin(pair) : 0,
        time: sessionEntryTime(pair[1], sortBy),
      };
    });
  const compare = (a: (typeof heads)[number], b: (typeof heads)[number]) =>
    b.pin - a.pin ||
    b.time - a.time ||
    (a.pair[0] < b.pair[0] ? -1 : a.pair[0] > b.pair[0] ? 1 : 0);
  heads.sort(compare);
  const entries: SessionEntryPair[] = [];
  const pageEnd = limit ?? Infinity;
  while (heads.length && entries.length < pageEnd) {
    const head = heads.shift()!;
    entries.push(head.pair);
    if (entries.length === limit || ++head.index === head.page.length) {
      continue;
    }
    head.pair = head.page[head.index]!;
    head.pin = sortBy === "updatedAt" ? sessionEntryPin(head.pair) : 0;
    head.time = sessionEntryTime(head.pair[1], sortBy);
    let low = 0;
    let high = heads.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(heads[middle]!, head) < 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    heads.splice(low, 0, head);
  }
  return entries;
}
