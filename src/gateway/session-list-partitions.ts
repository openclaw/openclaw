import {
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
} from "./session-identity-projection.js";
import {
  filterSessionEntries,
  type SessionListFilteredEntries,
  type SessionListFilterParams,
} from "./session-list-filters.js";
import {
  sessionEntryInsertionIndex,
  sortAndLimitSessionEntries,
  type SessionEntryPair,
} from "./session-list-order.js";
import type { createSessionRowSelection } from "./session-row-selection.js";
import { matchesSessionArchiveFilter } from "./session-utils-core.js";

export function filterSessionPartitions(
  params: SessionListFilterParams & {
    partitions: NonNullable<
      ReturnType<ReturnType<typeof createSessionRowSelection>["read"]>["partitions"]
    >;
    retained: WeakMap<object, SessionListFilteredEntries>;
    pageEnd: number | undefined;
    ownerLimit: number;
  },
): SessionListFilteredEntries {
  const { pageEnd, ownerLimit } = params;
  const entries: SessionEntryPair[] = [];
  const ownerEntries: SessionEntryPair[] = [];
  const owners = new Map<string, SessionListFilteredEntries["ownerFacet"][number]>();
  let totalCount = 0;
  let activityExpiresAt = Infinity;
  for (const partition of params.partitions) {
    if (!partition.entries.size) {
      continue;
    }
    let part = params.retained.get(partition.revision);
    // Expiry precedes owner/creator filters; rebuild that partition's clock aggregate.
    if (
      params.opts.activeMinutes !== undefined &&
      part?.partition!.version !== partition.revision.changes.length
    ) {
      part = undefined;
    }
    const changes = new Map<string, SessionEntryPair | undefined>();
    if (part) {
      for (
        let index = part.partition!.version;
        index < partition.revision.changes.length;
        index++
      ) {
        const change = partition.revision.changes[index]!;
        if (!changes.has(change.key)) {
          changes.set(change.key, change.previous);
        }
      }
    }
    const ownersByKey =
      part?.partition!.owners ??
      new Map<string, SessionListFilteredEntries["ownerFacet"][number]>();
    const filter = (keys: Iterable<string>) =>
      filterSessionEntries(
        {
          ...params,
          *entries(archived) {
            for (const key of keys) {
              const pair = partition.entries.get(key);
              if (pair && matchesSessionArchiveFilter(pair[1], archived)) {
                yield pair;
              }
            }
          },
        },
        undefined,
        ownersByKey,
      );
    if (!part) {
      part = filter(partition.entries.keys());
      part.entries = sortAndLimitSessionEntries(part.entries, undefined, params.opts.sortBy);
      part.ownerEntries = sortAndLimitSessionEntries(
        part.ownerEntries,
        undefined,
        params.opts.sortBy,
      );
      part.partition = { version: partition.revision.changes.length, owners: ownersByKey };
      params.retained.set(partition.revision, part);
    } else if (changes.size) {
      for (const [key, previous] of changes) {
        ownersByKey.delete(key);
        if (previous) {
          for (const ordered of [part.entries, part.ownerEntries]) {
            const index = sessionEntryInsertionIndex(ordered, previous, params.opts.sortBy);
            if (ordered[index] === previous) {
              ordered.splice(index, 1);
            }
          }
        }
      }
      const changed = filter(changes.keys());
      for (const [ordered, added] of [
        [part.entries, changed.entries],
        [part.ownerEntries, changed.ownerEntries],
      ] as const) {
        for (const pair of added) {
          ordered.splice(sessionEntryInsertionIndex(ordered, pair, params.opts.sortBy), 0, pair);
        }
      }
      const ownerFacet = new Map<string, SessionListFilteredEntries["ownerFacet"][number]>();
      for (const owner of ownersByKey.values()) {
        addSessionOwnerFacetIdentity(ownerFacet, owner);
      }
      part.ownerFacet = sortSessionOwnerFacet(ownerFacet);
      part.totalCount = part.entries.length;
      part.partition!.version = partition.revision.changes.length;
      params.retained.set(partition.revision, part);
    }
    entries.push(...part.entries.slice(0, pageEnd));
    ownerEntries.push(...part.ownerEntries.slice(0, ownerLimit));
    totalCount += part.totalCount;
    activityExpiresAt = Math.min(activityExpiresAt, part.activityExpiresAt ?? Infinity);
    for (const owner of part.ownerFacet) {
      addSessionOwnerFacetIdentity(owners, owner);
    }
  }
  return {
    entries,
    ownerEntries,
    totalCount,
    ownerFacet: sortSessionOwnerFacet(owners),
    ...(Number.isFinite(activityExpiresAt) ? { activityExpiresAt } : {}),
  };
}
