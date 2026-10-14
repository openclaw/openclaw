import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { HarnessCompletionSourceSnapshot } from "./session-harness-completion-source.types.js";

export type SessionActorMemoryCompletionReads = {
  "session.completion.read": {
    input: {
      sourceRunId: string;
      claim?: HarnessCompletionRecovery;
      mode?: "admission" | "committed";
      admission?: UserTurnTranscriptAdmissionReceipt;
    };
    output: HarnessCompletionSourceSnapshot & { hasSubmittedInput: boolean };
  };
};
