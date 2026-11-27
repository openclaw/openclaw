import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import { readPreparedSessionEntryPublicationSource } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { readPreparedSessionTranscriptChange } from "../config/sessions/session-transcript-authority.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  identity,
  isPreparedSessionRowDatabaseFacts,
  type PreparedSessionRowDatabaseFacts,
  type Query,
  type Row,
  type SessionRowStore,
} from "./session-row-projection-record.js";

const TRANSCRIPT_REFRESH_WINDOW_MS = 1_000;

function retainedTranscriptFacts(row: Row) {
  const facts = row.retainedDatabaseFacts ?? row.pendingDatabaseFacts;
  return isPreparedSessionRowDatabaseFacts(facts) && facts.entry === row.storedEntry
    ? facts
    : undefined;
}

/** Transcript notifications refresh presentation using installed row facts. */
export function createSessionRowProjectionTranscriptUpdates(params: {
  matching: (query: Query, kind?: string) => Row[];
  mark: (change: SessionRowChange) => void;
  read: (id: string) => Row | undefined;
  store: (path: string) => SessionRowStore | undefined;
  refresh: (id: string, retained?: PreparedSessionRowDatabaseFacts) => void;
  /** Invalidate the sharing revision even when presentation refreshes are throttled. */
  fence: () => void;
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
      const pending = row.pendingDatabaseFacts !== undefined;
      const retained = retainedTranscriptFacts(row);
      // Delayed or message-less notifications refresh the current committed facts.
      row.retainedDatabaseFacts = retained;
      row.databaseFactsRevision++;
      // Refresh pending presentation before cold-row or throttle suppression.
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
      // Only a certified postimage names a new transcript generation. `unknown` settlement and
      // `absent` rows carry no value, so they keep conservative invalidation below instead of
      // reading a generation that was never published.
      const postimage = fact.kind === "postimage" ? fact.value : undefined;
      const source = readPreparedSessionEntryPublicationSource(change);
      for (const row of params.matching({ ...change, key: change.sessionKey })) {
        if (source.identity !== params.store(row.storeTarget.storePath)?.identity) {
          continue;
        }
        const pending = row.pendingDatabaseFacts !== undefined;
        const facts = row.retainedDatabaseFacts ?? row.pendingDatabaseFacts;
        const retained =
          !change.factsInvalidated &&
          postimage !== undefined &&
          postimage.sessionId === facts?.entry?.sessionId &&
          isPreparedSessionRowDatabaseFacts(facts)
            ? {
                ...facts,
                activitySummaryWatermark: {
                  generation: postimage.generation,
                  maxSeq: postimage.rawSeq,
                },
                transcriptPreview: postimage.lastMessagePreview,
                transcriptHasMessages: postimage.hasMessages,
                transcriptAssistantMessage:
                  postimage.lastAssistantMessage === "unchanged"
                    ? facts.transcriptAssistantMessage
                    : postimage.lastAssistantMessage === undefined
                      ? "unknown"
                      : postimage.lastAssistantMessage,
                transcriptTerminalModel: postimage.terminalModel,
              }
            : undefined;
        // Pure appends preserve the transcript generation; destructive rewrites rotate it
        // and must fence recall reads that captured the old sharing revision. The mutation
        // owner certifies a destructive rewrite on the postimage itself, so classification
        // does not depend on the row carrying an activity-summary watermark. The watermark
        // comparison and the content-based clear fallback keep covering publications whose
        // owners do not certify the rewrite. Unknown or absent receipts cannot be proven
        // appends and keep conservative invalidation.
        const previousGeneration = facts?.activitySummaryWatermark?.generation;
        const fenceRecall =
          postimage === undefined ||
          postimage.destructiveRewrite === true ||
          (previousGeneration !== undefined
            ? previousGeneration !== postimage.generation
            : facts?.transcriptHasMessages === true &&
              (postimage.rawSeq === null || postimage.hasMessages === false));
        if (fenceRecall) {
          params.fence();
        }
        row.retainedDatabaseFacts = retained;
        if (
          !retained ||
          pending ||
          retained.transcriptPreview !== undefined ||
          readSessionActivitySummary(facts?.entry)
        ) {
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
