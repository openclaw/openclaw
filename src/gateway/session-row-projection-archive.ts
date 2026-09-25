import { isDeepStrictEqual } from "node:util";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import * as records from "./session-row-projection-record.js";

// Exact reads retain a small cache; larger list pages need their whole backfill window.
const DEFAULT_ARCHIVED_MATERIALIZED_ROWS = 100;

export function isColdArchivedSessionRow(row: records.Row) {
  return row.entry?.archivedAt !== undefined && !row.materialized;
}

/** Archived metadata outlives its bounded, reader-populated materialization cache. */
export function createSessionRowProjectionArchive(params: {
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  enqueue: (id: string, change?: SessionRowChange) => void;
  put: (row: records.Row) => void;
  release: (id: string) => void;
  config: () => records.Inputs["cfg"];
  context: () => Parameters<typeof records.readSessionRowLineage>[3];
  referenced: NonNullable<Parameters<typeof records.readSessionRowLineage>[4]>;
}) {
  const materialized = new Set<string>();
  const readPins = new Map<symbol, ReadonlySet<string>>();
  const pinCounts = new Map<string, number>();
  let limit = DEFAULT_ARCHIVED_MATERIALIZED_ROWS;
  function demote(row: records.Row): records.Row {
    const id = records.identity(row);
    materialized.delete(id);
    params.release(id);
    const cold = records.dematerialize(row);
    params.put(cold);
    return cold;
  }
  function trim() {
    for (const id of materialized) {
      if (materialized.size <= limit) {
        break;
      }
      if (!pinCounts.has(id)) {
        demote(params.rows.get(id)!);
      }
    }
  }
  function unpin(id: string) {
    const count = pinCounts.get(id)!;
    if (count === 1) {
      pinCounts.delete(id);
    } else {
      pinCounts.set(id, count - 1);
    }
  }
  function markRelated(
    row: records.Row,
    indexes: Parameters<typeof records.markRelated>[1],
    includeChildren = true,
  ) {
    const related = new Set<string>();
    records.markRelated(row, indexes, related, includeChildren, params.config());
    for (const id of related) {
      const current = params.rows.get(id);
      if (current && isColdArchivedSessionRow(current)) {
        if (!current.storedEntry) {
          continue;
        }
        const lineage = records.readSessionRowLineage(
          current,
          current.storedEntry,
          params.config(),
          params.context(),
          params.referenced,
        );
        if (
          records.sameParents(current.parents, lineage.parents) &&
          isDeepStrictEqual(current.entry, lineage.entry)
        ) {
          continue;
        }
        // Cold children retain metadata/indices; both parents must drop stale child links.
        const next = {
          ...current,
          ...lineage,
          pendingDatabaseFacts: undefined,
          retainedDatabaseFacts: undefined,
          databaseFactsRevision: current.databaseFactsRevision + 1,
        };
        params.put(next);
        markRelated(current, indexes, false);
        markRelated(next, indexes, false);
      } else if (current) {
        params.dirty.add(id);
      }
    }
  }
  return {
    demote,
    markRelated,
    deferAcquisition(row: records.Row) {
      const id = records.identity(row);
      params.put(row);
      params.dirty.add(id);
      params.enqueue(id);
      return undefined;
    },
    isCurrentMaterialization(row: records.Row) {
      const current = params.rows.get(records.identity(row));
      return (
        records.ready(current) &&
        (current.entry.archivedAt === undefined || current.materialized === row.materialized)
      );
    },
    invalidateRows(
      change: Extract<SessionRowChange, { all: true }>,
      candidates: Iterable<records.Row>,
    ) {
      const catalogOnly = change.scope === "catalog" && !change.factsInvalidated;
      for (const row of candidates) {
        if (catalogOnly && row.entry?.archivedAt === undefined) {
          if (!params.dirty.has(records.identity(row))) {
            row.pendingDatabaseFacts = row.retainedDatabaseFacts;
          }
        } else {
          row.pendingDatabaseFacts = undefined;
          row.retainedDatabaseFacts = undefined;
        }
        if (row.entry?.archivedAt !== undefined) {
          const current = row.materialized ? demote(row) : row;
          if (!catalogOnly) {
            records.invalidateDatabaseFacts(current);
          }
          if (current.preparedAcpMeta === undefined || current.hasBoard === undefined) {
            params.dirty.add(records.identity(current));
          }
          continue;
        }
        params.dirty.add(records.identity(row));
        params.enqueue(records.identity(row), change);
      }
    },
    setPageSize: (size: number) => {
      limit = Math.max(DEFAULT_ARCHIVED_MATERIALIZED_ROWS, size);
      trim();
    },
    // Disjoint prepared pages retain their own rows across worker and placement yields.
    retainRows(this: void) {
      const token = Symbol("archived session rows");
      readPins.set(token, new Set());
      return {
        update(ids: readonly string[]) {
          const previous = readPins.get(token);
          if (!previous) {
            return;
          }
          const next = new Set(ids);
          for (const id of previous) {
            if (!next.has(id)) {
              unpin(id);
            }
          }
          for (const id of next) {
            if (!previous.has(id)) {
              pinCounts.set(id, (pinCounts.get(id) ?? 0) + 1);
            }
          }
          readPins.set(token, next);
          trim();
        },
        release() {
          const ids = readPins.get(token);
          if (!ids) {
            return;
          }
          readPins.delete(token);
          for (const id of ids) {
            unpin(id);
          }
          trim();
        },
      };
    },
    forget: (id: string) => materialized.delete(id),
    clear() {
      materialized.clear();
      readPins.clear();
      pinCounts.clear();
    },
    describe(initial: records.Row | undefined) {
      if (initial?.entry?.archivedAt === undefined) {
        return initial;
      }
      const row = initial;
      if (records.ready(row) && row.entry.archivedAt !== undefined) {
        const id = records.identity(row);
        materialized.delete(id);
        materialized.add(id);
        trim();
      }
      return row;
    },
  };
}
