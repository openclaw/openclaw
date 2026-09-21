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
  enqueue: (id: string, change: SessionRowChange) => void;
  put: (row: records.Row) => void;
  release: (id: string) => void;
  prepare: (row: records.Row) => records.Row | undefined;
}) {
  const materialized = new Set<string>();
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
    while (materialized.size > limit) {
      demote(params.rows.get(materialized.values().next().value!)!);
    }
  }
  return {
    demote,
    isCurrentMaterialization(row: records.Row) {
      const current = params.rows.get(records.identity(row));
      return (
        records.ready(current) &&
        (current.entry.archivedAt === undefined || current.materialized === row.materialized)
      );
    },
    markRelated(row: records.Row, indexes: Parameters<typeof records.markRelated>[1]) {
      const related = new Set<string>();
      records.markRelated(row, indexes, related);
      for (const id of related) {
        const current = params.rows.get(id);
        if (current && !isColdArchivedSessionRow(current)) {
          params.dirty.add(id);
        }
      }
    },
    invalidateRows(
      change: Extract<SessionRowChange, { all: true }>,
      candidates: Iterable<records.Row>,
    ) {
      for (const row of candidates) {
        if (row.entry?.archivedAt !== undefined) {
          if (row.materialized) {
            demote(row);
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
    forget: (id: string) => materialized.delete(id),
    clear: () => materialized.clear(),
    describe(initial: records.Row | undefined) {
      if (initial?.entry?.archivedAt === undefined) {
        return initial;
      }
      const row = initial.materialized ? initial : params.prepare(initial);
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
