import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import { readSessionActorMemoryAnchors } from "./session-actor-memory-history-anchors.js";
import {
  readSessionActorMemoryContext,
  readSessionActorMemoryContextMessages,
  selectSessionActorMemoryAdmittedWindow,
} from "./session-actor-memory-history-context.js";
import type {
  SessionActorMemoryHistoryQuery,
  SessionActorMemoryHistoryReads,
} from "./session-actor-memory-history-contract.js";
import { readSessionActorMemoryHistoryFacts } from "./session-actor-memory-history-facts.js";
import {
  readSessionActorMemoryProjection,
  readSessionActorMemoryRawDelta,
  readSessionActorMemoryVisibleDelta,
  type SessionActorMemoryHistoryScope,
} from "./session-actor-memory-history-projection.js";
import { readSessionActorMemoryHistory } from "./session-actor-memory-history.js";
import {
  resolveSessionActorMemoryWindow,
  type SessionActorMemoryState,
} from "./session-actor-memory-state.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";

/** Runs synchronously in the actor's owner-wide FIFO. The facade detaches its result. */
export function readSessionActorMemoryHistoryQuery(
  state: SessionActorMemoryState,
  query: SessionActorMemoryHistoryQuery,
  scope: SessionActorMemoryHistoryScope,
): SessionActorMemoryHistoryReads[keyof SessionActorMemoryHistoryReads]["output"] {
  const selected = resolveSessionActorMemoryWindow(state, query.input.sessionId);
  if (!selected) {
    throw new Error("Session transcript window is unavailable");
  }
  if (query.type === "session.history.anchors") {
    return readSessionActorMemoryAnchors(
      selected,
      { ...scope, currentEntry: state.hot.entry },
      query.input,
    );
  }
  const admission = "admission" in query.input ? query.input.admission : undefined;
  if (
    query.type === "session.history.maintenance" &&
    query.input.request.operation === "suffix" &&
    admission &&
    selected.events.some((row) => row.rawSeq >= admission.rawSeq)
  ) {
    throw new SessionTranscriptReadFenceError(
      "Transcript suffix crosses the current-turn admission fence",
    );
  }
  const window = selectSessionActorMemoryAdmittedWindow(selected, scope, admission);
  const readScope = admission
    ? {
        ...scope,
        readFence: {
          beforeRawSeq: admission.rawSeq,
          beforeActiveMessagePosition: admission.activeMessagePosition,
        },
      }
    : scope;
  switch (query.type) {
    case "session.history.hydrate": {
      const max = query.input.maxEventBytes;
      if (!query.input.limits && max !== undefined && Number.isFinite(max) && max >= 0) {
        let bytes = 0;
        for (const [index, row] of window.events.entries()) {
          bytes += Buffer.byteLength(row.eventJson) + (index > 0 ? 1 : 0);
          if (bytes > Math.floor(max)) {
            throw new SqliteJsonlReadBudgetExceededError(
              `Trajectory transcript store is too large to export (at least ${bytes} bytes; limit ${Math.floor(max)})`,
            );
          }
        }
      }
      return readSessionActorMemoryHistory(window, query.input.limits);
    }
    case "session.history.context-messages":
      return readSessionActorMemoryContextMessages(window);
    case "session.history.context":
      return readSessionActorMemoryContext(window, scope, query.input.through, query.input.limits);
    case "session.history.raw-delta":
      return readSessionActorMemoryRawDelta(window, readScope, query.input.limits);
    case "session.history.visible-delta":
      return readSessionActorMemoryVisibleDelta(window, readScope, query.input.limits);
    case "session.history.count":
      return readSessionActorMemoryProjection(window, readScope, { kind: "count" });
    case "session.history.delta":
      return readSessionActorMemoryProjection(window, readScope, { kind: "delta", ...query.input });
    case "session.history.recent":
      return readSessionActorMemoryProjection(window, readScope, {
        kind: "recent",
        ...query.input,
      });
    case "session.history.recent-text":
      return readSessionActorMemoryProjection(window, readScope, {
        kind: "recent-text",
        ...query.input,
      });
    case "session.history.page":
      return readSessionActorMemoryProjection(window, readScope, { kind: "page", ...query.input });
    case "session.history.around-id":
      return readSessionActorMemoryProjection(window, readScope, {
        kind: "around-id",
        ...query.input,
      });
    case "session.history.by-id":
      return readSessionActorMemoryProjection(window, readScope, { kind: "by-id", ...query.input });
    case "session.history.source":
      return readSessionActorMemoryProjection(window, readScope, {
        kind: "source",
        ...query.input,
      });
    case "session.history.lookup":
      return readSessionActorMemoryProjection(window, readScope, {
        kind: "lookup",
        ...query.input,
      });
    default:
      return readSessionActorMemoryHistoryFacts(window, query);
  }
}
