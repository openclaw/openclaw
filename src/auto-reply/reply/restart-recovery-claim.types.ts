import type { RestartRecoveryBeforeAgentReplyState } from "../../config/sessions/restart-recovery-types.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { AgentTurnRestartClaimCleanup } from "./agent-runner-completion.types.js";

export type ReplyRestartRecoveryClaimController = {
  admitUserTurn: (
    recorder?: UserTurnTranscriptRecorder,
  ) => Promise<"admitted" | "duplicate-source">;
  beginBeforeAgentReply: () => Promise<boolean>;
  checkpointBeforeAgentReply: (params: {
    state?: RestartRecoveryBeforeAgentReplyState;
    pendingFinalDelivery?: {
      context?: DeliveryContext;
      deliveries: NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"];
      intentId: string;
      text: string;
    };
  }) => Promise<void>;
  clear: () => Promise<void>;
  prepareCompletionCleanup: (entry: SessionEntry) => AgentTurnRestartClaimCleanup | undefined;
  isArmed: () => Promise<boolean>;
};
