import type { SessionGoalOperation } from "../../config/sessions/goals-operations.types.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { ProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { LoadedChatSendSession } from "./chat-send-session.js";
import type { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type ChatSendPreAdmissionParams = {
  assertCurrentAsync?: () => Promise<void>;
  withCurrent?: <T>(consume: () => T) => Promise<T>;
  request: NormalizedChatSendRequest;
  session: LoadedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  assertCurrent?: () => void;
};

export type ChatSendInternalOptions = {
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  goalResume?: SessionGoalOperation & { action: "resume" };
  trustedSystemInput?: boolean;
  transcript?: Parameters<typeof createGatewayChatUserTurnController>[0]["transcript"];
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  toolsAllow?: string[];
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
};
