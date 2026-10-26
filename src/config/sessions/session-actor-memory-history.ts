import { readSessionActorBoundedHistory } from "./session-actor-bounded-history.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionTranscriptContextSelection,
} from "./session-history-read.types.js";

/** The actor already owns these bytes; limits select a detached view, never a second store. */
export function readSessionActorMemoryHistory(
  state: SessionActorMemoryWindow,
  limits?: SessionTranscriptContextSelection,
): PreparedSessionTranscriptHydration {
  if (!limits) {
    return {
      kind: "full",
      snapshot: {
        events: structuredClone(state.events.map((row) => row.event)),
        eventJson: state.events.map((row) => row.eventJson),
        eventSeqs: state.events.map((row) => row.rawSeq),
        version: { ...state.hot.transcript.version },
      },
    };
  }
  return readSessionActorBoundedHistory(
    {
      hot: state.hot,
      events: state.events.map((row) => ({
        ...row,
        serializedBytes: Buffer.byteLength(row.eventJson) + 1,
      })),
    },
    limits,
  );
}
