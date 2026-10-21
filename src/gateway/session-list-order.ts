// Bounded session-list ordering shared by synchronous and asynchronous projections.

import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { sortAndLimitByWork } from "../shared/sort-and-limit.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";

type SelectionFacts = Readonly<
  Record<NonNullable<SessionsListParams["sortBy"]>, number> & { pinnedAt?: number }
>;
export type SessionListEntry = readonly [
  key: string,
  entry: SessionEntry,
  selection: SelectionFacts,
];

export function compareSessionEntries(
  aKey: string,
  a: SelectionFacts,
  bKey: string,
  b: SelectionFacts,
  sortBy: SessionsListParams["sortBy"] = "updatedAt",
): number {
  if (sortBy === "updatedAt") {
    const aPinnedAt = a.pinnedAt ?? 0;
    const bPinnedAt = b.pinnedAt ?? 0;
    if (aPinnedAt !== bPinnedAt) {
      return bPinnedAt - aPinnedAt;
    }
  }
  const byTimestamp = b[sortBy] - a[sortBy];
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  // Stable key ties keep offset paging deterministic across calls.
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

export function* sortAndLimitSessionEntries(
  entries: SessionListEntry[],
  limit: number | undefined,
  sortBy: SessionsListParams["sortBy"],
  shouldYield?: () => boolean,
): SynchronousWork<SessionListEntry[]> {
  return yield* sortAndLimitByWork(
    entries,
    limit,
    (a, b) => compareSessionEntries(a[0], a[2], b[0], b[2], sortBy),
    shouldYield,
  );
}
