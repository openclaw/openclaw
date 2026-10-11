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
  invalidateTranscript: (id: string) => void;
  put: (row: records.Row) => void;
  release: (id: string) => void;
  invalidateFacts: (row: records.Row) => void;
  config: () => records.Inputs["cfg"];
  context: () => Parameters<typeof records.readSessionRowLineage>[3];
  referenced: NonNullable<Parameters<typeof records.readSessionRowLineage>[4]>;
}) {
  const materialized = new Set<string>();
  const readPins = new Set<ReadonlySet<string>>();
  let limit = DEFAULT_ARCHIVED_MATERIALIZED_ROWS;
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
  function trim() {
    for (const id of materialized) {
      if (materialized.size <= limit) {
        break;
      }
      if (![...readPins].some((pins) => pins.has(id))) {
        demote(params.rows.get(id)!);
      }
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
          isDeepStrictEqual(current.parents, lineage.parents) &&
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
      return undefined;
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
        if (catalogOnly && row.entry?.archivedAt === undefined) {
          if (!params.dirty.has(records.identity(row))) {
            row.pendingDatabaseFacts = records.isPreparedSessionRowDatabaseFacts(
              row.retainedDatabaseFacts,
            )
              ? row.retainedDatabaseFacts
              : undefined;
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
        if (
          typeof change.scope !== "string" ||
          change.factsInvalidated ||
          ((change.scope === "config" || change.scope === "catalog") && row.entry?.fallbackNotice)
        ) {
          params.invalidateTranscript(records.identity(row));
        }
      }
    },
    setPageSize: (size: number) => {
      limit = Math.max(DEFAULT_ARCHIVED_MATERIALIZED_ROWS, size);
      trim();
    },
    // Disjoint prepared pages retain their own rows across worker and placement yields.
    retainRows(this: void) {
      let pins: ReadonlySet<string> = new Set();
      readPins.add(pins);
      return {
        update(ids: readonly string[]) {
          readPins.delete(pins);
          pins = new Set(ids);
          readPins.add(pins);
          trim();
        },
        release() {
          readPins.delete(pins);
          trim();
        },
      };
    },
    forget: (id: string) => materialized.delete(id),
    clear() {
      materialized.clear();
      readPins.clear();
    },
    describe(row: records.Row | undefined) {
      if (row?.entry?.archivedAt === undefined) {
        return row;
      }
      if (records.ready(row)) {
        const id = records.identity(row);
        materialized.delete(id);
        materialized.add(id);
        trim();
      }
      return row;
    },
  };
}
