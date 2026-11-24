// Bounded session-list ordering shared by synchronous and asynchronous projections.
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { recordSessionRowPartitionCache } from "../infra/gateway-work-metrics.js";
import { getMainThreadTaskName } from "../infra/main-thread-stall.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";
import {
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
} from "./session-identity-projection.js";
import {
  filterSessionEntries,
  type SessionListFilteredEntries,
  type SessionListFilterParams,
  type SessionEntrySelection,
} from "./session-list-filters.js";
import {
  mergeSessionListOwnerCounts,
  retainCurrentSessionListPartitions,
} from "./session-list-view-cache.js";
import type { createSessionRowSelection } from "./session-row-selection.js";

export type SessionEntryPair = [string, SessionEntry];

export type SessionPinRank = (pair: SessionEntryPair) => number;

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
  personalPinRank?: SessionPinRank,
): SessionEntryPair[] {
  const timestamps = new Float64Array(entries.length);
  const pins =
    personalPinRank || sortBy === "updatedAt" ? new Float64Array(entries.length) : undefined;
  const indices = Array<number>(entries.length);
  for (let index = 0; index < entries.length; index++) {
    const pair = entries[index]!;
    timestamps[index] = sessionEntryTime(pair[1], sortBy);
    if (pins) {
      pins[index] = (personalPinRank ?? sessionEntryPin)(pair);
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
  personalPinRank?: SessionPinRank,
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
        pin: personalPinRank?.(pair) ?? (sortBy === "updatedAt" ? sessionEntryPin(pair) : 0),
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
    head.pin =
      personalPinRank?.(head.pair) ?? (sortBy === "updatedAt" ? sessionEntryPin(head.pair) : 0);
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

export function selectSessionEntries(
  params: SessionListFilterParams & {
    defaultLimit?: number;
    partitions?: ReturnType<ReturnType<typeof createSessionRowSelection>["read"]>["partitions"];
    retained?: Map<object, SessionListFilteredEntries>;
  },
): SessionEntrySelection {
  const limit = resolveOptionalIntegerOption(params.opts.limit, { min: 1 }) ?? params.defaultLimit;
  const offset = resolveNonNegativeIntegerOption(params.opts.offset, 0);
  const ownerLimit =
    !(params.opts.pinned === true && params.personalPinRank) &&
    params.ownerFirstActorId &&
    offset === 0
      ? Math.min(limit ?? SESSIONS_LIST_OWNER_LIMIT, SESSIONS_LIST_OWNER_LIMIT)
      : 0;
  const pageEnd =
    limit === undefined ? undefined : Math.min(offset + limit, Number.MAX_SAFE_INTEGER);
  // Person-reference resolution and people truncation require the whole visible roster.
  // Temporal queries are not retained by the presentation owner.
  const incremental =
    params.partitions &&
    params.retained &&
    !params.opts.includePeople &&
    !params.opts.involvingProfileId;
  const rank =
    (params.opts.sortBy ?? "updatedAt") === "updatedAt" ? params.personalPinRank : undefined;
  let filteredResult: SessionListFilteredEntries;
  if (incremental) {
    retainCurrentSessionListPartitions(params.retained!, params.partitions!);
    const pages: SessionEntryPair[][] = [];
    const ownerPages: SessionEntryPair[][] = [];
    const owners = new Map<string, SessionListFilteredEntries["ownerFacet"][number]>();
    const countParts: SessionListFilteredEntries[] | undefined = params.opts
      .includeOwnerSessionCounts
      ? []
      : undefined;
    let totalCount = 0;
    let hits = 0;
    let misses = 0;
    let activityExpiresAt = Infinity;
    const archived = params.opts.archived ?? false;
    for (const partition of params.partitions!) {
      if (!partition.entries.size || (archived !== "all" && partition.archived !== archived)) {
        continue;
      }
      let part = params.retained!.get(partition.revision);
      if (!part) {
        misses++;
        part = filterSessionEntries({
          ...params,
          entries: () => partition.entries.values(),
        });
        part.entries = sortAndLimitSessionEntries(part.entries, pageEnd, params.opts.sortBy, rank);
        part.ownerEntries = sortAndLimitSessionEntries(
          part.ownerEntries,
          ownerLimit,
          params.opts.sortBy,
          rank,
        );
        params.retained!.set(partition.revision, part);
      } else {
        hits++;
      }
      countParts?.push(part);
      pages.push(part.entries);
      ownerPages.push(part.ownerEntries);
      totalCount += part.totalCount;
      activityExpiresAt = Math.min(activityExpiresAt, part.activityExpiresAt ?? Infinity);
      for (const owner of part.ownerFacet) {
        addSessionOwnerFacetIdentity(owners, owner);
      }
    }
    recordSessionRowPartitionCache(hits, misses, getMainThreadTaskName());
    filteredResult = {
      entries: mergeSessionEntryPages(pages, pageEnd, params.opts.sortBy, rank),
      ownerEntries: mergeSessionEntryPages(ownerPages, ownerLimit, params.opts.sortBy, rank),
      totalCount,
      ownerFacet: sortSessionOwnerFacet(owners),
      ...(countParts ? mergeSessionListOwnerCounts(countParts) : {}),
      ...(Number.isFinite(activityExpiresAt) ? { activityExpiresAt } : {}),
    };
  } else {
    filteredResult = filterSessionEntries(
      params,
      params.entriesSorted ? { offset, limit, ownerLimit } : undefined,
    );
  }
  const { ownerEntries, entries: filtered, ...facets } = filteredResult;
  const sharedEntries = incremental
    ? offset === 0
      ? filtered
      : filtered.slice(offset)
    : params.entriesSorted
      ? filtered
      : sortAndLimitSessionEntries(filtered, pageEnd, params.opts.sortBy, rank).slice(offset);
  let entries = sharedEntries;
  let ownerCount = 0;
  if (ownerLimit > 0) {
    const owned =
      params.entriesSorted || incremental
        ? ownerEntries
        : sortAndLimitSessionEntries(ownerEntries, ownerLimit, params.opts.sortBy, rank);
    ownerCount = owned.length;
    const ownedKeys = new Set(owned.map(([key]) => key));
    entries = [...owned, ...sharedEntries.filter(([key]) => !ownedKeys.has(key))];
  }
  const nextOffset = offset + sharedEntries.length;
  const hasMore = nextOffset < facets.totalCount;
  return {
    ...facets,
    entries,
    ownerCount,
    limitApplied: limit,
    offset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
  };
}
