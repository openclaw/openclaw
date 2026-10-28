import type { InternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import type { SessionRestartResume } from "../../config/sessions/restart-resume.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { ProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { SessionControllerInput } from "../../sessions/session-controller.contracts.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
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
  /** Captured execution restrictions for a host-owned successor, never wire parameters. */
  continuationPolicy?: Pick<
    InternalGetReplyOptions,
    | "forceRestartSafeTools"
    | "forceCodeModeTools"
    | "sourceReplyDeliveryMode"
    | "cronCreatorAuthorityCapability"
    | "prepareMessageActionTurnCapability"
  >;
  /** Adopt the lifecycle producer's exact already-reserved mailbox input. */
  controllerInput?: SessionControllerInput;
  onExecutionStarted?: () => void;
  /** The pending input and its lifecycle patch committed into this source. */
  onInputCommitted?: () => void;
  /** Observe the exact registered source before asynchronous input preparation. */
  onSourceAdmitted?: (source: RpcSourceRef) => void;
  beforeDispatch?: (params: {
    runId: string;
    assertCurrent: () => void;
    assertWorkAdmissionCurrent: () => void;
  }) => Promise<void | (() => void)>;
};
