import type {
  SessionTranscriptProjectionSelection,
  SessionTranscriptProjectionSelectionResults,
} from "../../gateway/session-transcript-read.types.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
} from "./session-accessor.types.js";
import type {
  SessionActorMemoryHistoryFactsReads,
  SessionActorMemoryAnchorReads,
} from "./session-actor-memory-history-facts-contract.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

type Target = { sessionId?: string; admission?: UserTurnTranscriptAdmissionReceipt };
type ProjectionReads = {
  [Key in keyof SessionTranscriptProjectionSelectionResults as `session.history.${Key}`]: {
    input: Target & Omit<Extract<SessionTranscriptProjectionSelection, { kind: Key }>, "kind">;
    output: SessionTranscriptProjectionSelectionResults[Key];
  };
};

export type SessionActorMemoryHistoryReads = ProjectionReads &
  SessionActorMemoryHistoryFactsReads &
  SessionActorMemoryAnchorReads & {
    "session.history.hydrate": {
      input: Target & { limits?: { maxBytes: number; maxEvents: number }; maxEventBytes?: number };
      output: PreparedSessionTranscriptHydration;
    };
    "session.history.context": {
      input: Target & { through?: TranscriptEntryAnchor; limits?: SessionModelContextLimits };
      output: SessionTranscriptModelContext;
    };
    "session.history.raw-delta": {
      input: Target & { limits: SessionTranscriptRawDeltaLimits };
      output: SessionTranscriptRawDeltaResult;
    };
    "session.history.visible-delta": {
      input: Target & { limits: SessionTranscriptVisibleMessageDeltaLimits };
      output: SessionTranscriptVisibleMessageDeltaResult;
    };
  };
export type SessionActorMemoryHistoryQuery = {
  [Key in keyof SessionActorMemoryHistoryReads]: {
    type: Key;
    input: SessionActorMemoryHistoryReads[Key]["input"];
  };
}[keyof SessionActorMemoryHistoryReads];
