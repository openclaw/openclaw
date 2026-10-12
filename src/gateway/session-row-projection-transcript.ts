import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import { readPreparedSessionEntryPublicationSource } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { readPreparedSessionTranscriptChange } from "../config/sessions/session-transcript-authority.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  identity,
  isPreparedSessionRowDatabaseFacts,
  type PreparedSessionRowDatabaseFacts,
  type Query,
  type Row,
  type SessionRowStore,
} from "./session-row-projection-record.js";

const TRANSCRIPT_REFRESH_WINDOW_MS = 1_000;

function retainedTranscriptFacts(row: Row, update?: InternalSessionTranscriptUpdate) {
  const facts = row.retainedDatabaseFacts ?? row.pendingDatabaseFacts;
  const authority = row.transcriptAuthority;
  const covered =
    authority &&
    authority.sessionId === facts?.entry?.sessionId &&
    (!update ||
      (update.messageId !== undefined &&
        update.messageId === authority.leafEventId &&
        (update.messageSeq === undefined || update.messageSeq === authority.activeMessageCount)));
  if (!isPreparedSessionRowDatabaseFacts(facts) || facts.entry !== row.storedEntry) {
    return undefined;
  }
  return covered
    ? facts
    : !readSessionActivitySummary(facts.entry)
      ? { ...facts, activitySummaryWatermark: undefined }
      : undefined;
}

/** Transcript notifications share the projection's lifetime and exact row generations. */
export function createSessionRowProjectionTranscriptUpdates(params: {
  matching: (query: Query, kind?: string) => Row[];
  mark: (change: SessionRowChange) => void;
  read: (id: string) => Row | undefined;
  store: (path: string) => SessionRowStore | undefined;
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
  function startWindow(id: string) {
    const timer = setTimeout(() => {
      const window = windows.get(id);
      windows.delete(id);
      const row = params.read(id);
      if (!row) {
        return;
      }
      if (window?.pending) {
        // The trailing edge starts the next window, bounding sustained streams too.
        startWindow(id);
        params.refresh(id, retainedTranscriptFacts(row));
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
          ? retainedTranscriptFacts(row, update)
          : undefined;
      // Notifications reuse only the exact canonical receipt. An unpaired update
      // still falls back to bounded acquisition instead of guessing transcript order.
      row.retainedDatabaseFacts = retained;
      if (!retained?.activitySummaryWatermark) {
        row.transcriptAuthority = undefined;
      }
      row.databaseFactsRevision++;
      // Accepted snapshots must install the committed watermark or revoke it before
      // cold-row or throttle suppression; an exact read may resume before the next window.
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
      startWindow(id);
      // Transcript watermarks and previews are row-local. Relationships, inherited model
      // settings, and subagent activity change through their own sessionChanges publications.
      if (!cold && !pending) {
        params.refresh(id, retained);
      }
    }
  });
  return {
    remove,
    publish(change: SessionRowChange) {
      if (disposed || !("sessionKey" in change) || change.scope !== "transcript") {
        return;
      }
      const fact = readPreparedSessionTranscriptChange(change);
      if (!fact || fact.kind === "unchanged") {
        return;
      }
      const source = readPreparedSessionEntryPublicationSource(change);
      for (const row of params.matching({ ...change, key: change.sessionKey })) {
        if (source.identity !== params.store(row.storeTarget.storePath)?.identity) {
          continue;
        }
        const pending = row.pendingDatabaseFacts !== undefined;
        const facts = row.retainedDatabaseFacts ?? row.pendingDatabaseFacts;
        const authority =
          !change.factsInvalidated &&
          fact.kind === "postimage" &&
          fact.value.sessionId === facts?.entry?.sessionId
            ? freezeJsonSnapshot(fact.value)
            : undefined;
        const retained =
          authority && isPreparedSessionRowDatabaseFacts(facts)
            ? {
                ...facts,
                activitySummaryWatermark: {
                  generation: authority.generation,
                  maxSeq: authority.rawSeq,
                },
              }
            : undefined;
        row.transcriptAuthority = authority;
        row.retainedDatabaseFacts = retained;
        if (!retained || pending || readSessionActivitySummary(facts?.entry)) {
          params.refresh(identity(row), retained);
        } else {
          row.databaseFactsRevision++;
        }
      }
    },
    dispose() {
      disposed = true;
      stop();
      for (const id of windows.keys()) {
        remove(id);
      }
    },
  };
}
