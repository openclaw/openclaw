import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import type { SessionRestartResume } from "../../config/sessions/restart-resume.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { ProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";

export type ChatSendInternalOptions = {
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  goalResume?: SessionGoalOperation & { action: "resume" };
  restartResume?: SessionRestartResume;
  trustedSystemInput?: boolean;
  /** The creation owner has validated an agent-authored opening turn and its source authority. */
  stageCreatedInput?: true;
  transcript?: Parameters<typeof createGatewayChatUserTurnController>[0]["transcript"];
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  toolsAllow?: string[];
  beforeDispatch?: (params: {
    runId: string;
    assertCurrent: () => void;
    assertWorkAdmissionCurrent: () => void;
  }) => Promise<void | (() => void)>;
};
