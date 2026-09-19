import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { identity, type Query, type Row } from "./session-row-projection-record.js";

const TRANSCRIPT_REFRESH_WINDOW_MS = 1_000;

/** Transcript notifications share the projection's lifetime and exact row generations. */
export function createSessionRowProjectionTranscriptUpdates(params: {
  matching: (query: Query, kind?: string) => Row[];
  mark: (change: SessionRowChange) => void;
  read: (id: string) => Row | undefined;
  refresh: (id: string) => void;
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
      if (disposed || params.read(id)?.generation !== generation) {
        return;
      }
      if (window.pending) {
        // The trailing edge starts the next window, bounding sustained streams too.
        startWindow(id, generation);
        params.refresh(id);
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
      if (row.entry?.archivedAt !== undefined && !row.materialized) {
        continue;
      }
      const id = identity(row);
      const window = windows.get(id);
      if (window) {
        window.pending = true;
        continue;
      }
      startWindow(id, row.generation);
      // Transcript watermarks and previews are row-local. Relationships, inherited model
      // settings, and subagent activity change through their own sessionChanges publications.
      if (!cold) {
        params.refresh(id);
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
