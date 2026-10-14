import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { ProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";

export type ChatSendInternalOptions = {
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  goalResume?: SessionGoalOperation & { action: "resume" };
  trustedSystemInput?: boolean;
  transcript?: Parameters<typeof createGatewayChatUserTurnController>[0]["transcript"];
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  toolsAllow?: string[];
  beforeDispatch?: (params: {
    runId: string;
    assertCurrent: () => void;
    assertWorkAdmissionCurrent: () => void;
  }) => Promise<void | (() => void)>;
};
