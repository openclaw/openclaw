import { isDeepStrictEqual } from "node:util";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import * as records from "./session-row-projection-record.js";

// Live and archived rows share one cache; prepared reads pin their complete page.
const DEFAULT_MATERIALIZED_ROWS = 100;

export function isColdSessionRow(row: records.Row) {
  return !row.materialized && (row.entry?.archivedAt !== undefined || row.displayEvicted === true);
}

/** Metadata outlives its bounded, reader-populated materialization cache. */
export function createSessionRowProjectionArchive(params: {
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  isSessionSubscribed?: records.ProjectionOptions["isSessionSubscribed"];
  enqueue: (id: string, change?: SessionRowChange) => void;
  put: (row: records.Row) => void;
  release: (id: string) => void;
  invalidateFacts: (row: records.Row) => void;
  config: () => records.Inputs["cfg"];
  context: () => Parameters<typeof records.readSessionRowLineage>[3];
  referenced: NonNullable<Parameters<typeof records.readSessionRowLineage>[4]>;
}) {
  const materialized = new Set<string>();
  const readPins = new Map<symbol, ReadonlySet<string>>();
  const pinCounts = new Map<string, number>();
  let limit = DEFAULT_MATERIALIZED_ROWS;
  function demote(row: records.Row): records.Row {
    const id = records.identity(row);
    materialized.delete(id);
    params.release(id);
    const cold = records.dematerialize(row);
    params.put(cold);
    // Eviction releases display custody, not unresolved database-fact preparation.
    if (cold.unresolvedDatabaseFacts === "category") {
      params.dirty.add(id);
    }
    return cold;
  }
  function trim(reading?: string) {
    for (const id of materialized) {
      if (materialized.size <= limit) {
        break;
      }
      if (id !== reading && !pinCounts.has(id)) {
        const row = params.rows.get(id)!;
        if (
          (row.entry?.archivedAt !== undefined || !params.dirty.has(id)) &&
          !params.isSessionSubscribed?.(row)
        ) {
          demote(row);
        }
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
      if (current && isColdSessionRow(current)) {
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
      return records.ready(current) && current.materialized === row.materialized;
    },
    invalidateRows(
      change: Extract<SessionRowChange, { all: true }>,
      candidates: Iterable<records.Row>,
    ) {
      const catalogOnly = change.scope === "catalog" && !change.factsInvalidated;
      for (const row of candidates) {
        if (change.factsInvalidated) {
          params.invalidateFacts(row);
        }
        if (catalogOnly && row.entry?.archivedAt === undefined && !isColdSessionRow(row)) {
          if (!params.dirty.has(records.identity(row))) {
            row.pendingDatabaseFacts = row.retainedDatabaseFacts;
          }
        } else {
          row.pendingDatabaseFacts = undefined;
          row.retainedDatabaseFacts = undefined;
        }
        if (row.entry?.archivedAt !== undefined || isColdSessionRow(row)) {
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
      limit = Math.max(DEFAULT_MATERIALIZED_ROWS, size);
      trim();
    },
    // Disjoint prepared pages retain their own rows across worker and placement yields.
    retainRows(this: void) {
      const token = Symbol("session row read");
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
    describe(row: records.Row | undefined) {
      if (records.ready(row)) {
        const id = records.identity(row);
        materialized.delete(id);
        materialized.add(id);
        trim(id);
      }
      return row;
    },
  };
}
