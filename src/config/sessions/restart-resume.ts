import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";

/** A Gateway-prepared operator input, never a restored execution capability. */
export type SessionRestartResume = {
  sessionId: string;
  lifecycleRevision: string | undefined;
  forceRestartSafeTools: boolean;
  forceCodeModeTools?: true;
  expectedState: SessionTranscriptTurnExpectedState;
  lifecycle: SessionTranscriptTurnLifecyclePatch;
};

export type SessionInputLifecycleAdmission = Pick<
  SessionRestartResume,
  "expectedState" | "lifecycle"
>;
