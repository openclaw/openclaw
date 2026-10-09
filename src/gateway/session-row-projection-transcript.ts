import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  identity,
  isPreparedSessionRowDatabaseFacts,
  type PreparedSessionRowDatabaseFacts,
  type Query,
  type Row,
} from "./session-row-projection-record.js";

const TRANSCRIPT_REFRESH_WINDOW_MS = 1_000;

function transcriptIndependentFacts(row: Row) {
  const facts = row.retainedDatabaseFacts;
  return isPreparedSessionRowDatabaseFacts(facts) &&
    facts.entry === row.storedEntry &&
    !readSessionActivitySummary(facts.entry)
    ? facts
    : undefined;
}

/** Transcript notifications share the projection's lifetime and exact row generations. */
export function createSessionRowProjectionTranscriptUpdates(params: {
  matching: (query: Query, kind?: string) => Row[];
  mark: (change: SessionRowChange) => void;
  read: (id: string) => Row | undefined;
  invalidate: (id: string) => void;
  refresh: (id: string, retained?: PreparedSessionRowDatabaseFacts) => void;
}) {
  const windows = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: boolean }>();
  let disposed = false;
  function remove(id: string) {
    const window = windows.get(id);
    if (window) {
      clearTimeout(window.timer);
      windows.delete(id);
    }
  }
  function startWindow(id: string, generation: Row["generation"]) {
    const timer = setTimeout(() => {
      const window = windows.get(id);
      if (window?.timer !== timer) {
        return;
      }
      windows.delete(id);
      const row = params.read(id);
      if (disposed || !row || row.generation !== generation) {
        return;
      }
      if (window.pending) {
        // The trailing edge starts the next window, bounding sustained streams too.
        startWindow(id, generation);
        params.refresh(id, transcriptIndependentFacts(row));
      }
    }, TRANSCRIPT_REFRESH_WINDOW_MS);
    timer.unref();
    windows.set(id, { timer, pending: false });
  }
  const stop = onInternalSessionTranscriptUpdate((update) => {
    const change = update.target;
    if (disposed || !change) {
      return;
    }
    const query = { ...change, key: change.sessionKey };
    let found = new Set([...params.matching(query), ...params.matching(query, "id")]);
    const cold = found.size === 0;
    if (cold) {
      // Retain exact-key admission when the first observation is a transcript publication.
      params.mark(change);
      found = new Set([...params.matching(query), ...params.matching(query, "id")]);
    }
    for (const row of found) {
      const id = identity(row);
      params.invalidate(id);
      const pending = row.pendingDatabaseFacts !== undefined;
      const retained =
        row.storedEntry?.sessionId === change.sessionId &&
        (update.lifecycleRevision === undefined ||
          row.storedEntry.lifecycleRevision === update.lifecycleRevision)
          ? transcriptIndependentFacts(row)
          : undefined;
      // Only summary-bearing facts contain a transcript watermark. Keep unrelated
      // committed facets while still revoking every in-flight transcript snapshot.
      row.retainedDatabaseFacts = retained;
      row.databaseFactsRevision++;
      // Accepted snapshots must lose their watermark before cold-row or throttle
      // suppression; an exact read may resume before the next refresh window.
      if (pending) {
        params.refresh(id, retained);
      }
      if (row.entry?.archivedAt !== undefined && !row.materialized) {
        continue;
      }
      const window = windows.get(id);
      if (window) {
        window.pending = true;
        continue;
      }
      startWindow(id, row.generation);
      // Transcript watermarks and previews are row-local. Relationships, inherited model
      // settings, and subagent activity change through their own sessionChanges publications.
      if (!cold && !pending) {
        params.refresh(id, retained);
      }
    }
  });
  return {
    remove,
    dispose() {
      disposed = true;
      stop();
      for (const id of windows.keys()) {
        remove(id);
      }
    },
  };
}
