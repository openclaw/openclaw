import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";

/** Lifecycle bookkeeping committed atomically with an ordinary accepted input. */
export type SessionInputLifecycleAdmission = {
  expectedState: SessionTranscriptTurnExpectedState;
  lifecycle: SessionTranscriptTurnLifecyclePatch;
};
