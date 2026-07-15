import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

export type RestartRecoveryBeforeAgentReplyState =
  | "pending"
  | "continue"
  | "handled-silent"
  | "handled-reply"
  | "handled-unrecoverable";

/** Durable ownership and idempotency state for gateway restart recovery. */
export type SessionRestartRecoveryState = {
  restartRecoveryBeforeAgentReplyState?: RestartRecoveryBeforeAgentReplyState;
  restartRecoveryDeliveryContext?: DeliveryContext;
  restartRecoveryDeliveryRequestFingerprint?: string;
  restartRecoveryDeliveryRunId?: string;
  restartRecoveryDeliverySourceRunId?: string;
  restartRecoveryRequesterAccountId?: string;
  restartRecoveryRequesterSenderId?: string;
  restartRecoverySameChannelThreadRequired?: true;
  restartRecoverySourceIngress?: "channel";
  restartRecoverySourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  restartRecoveryTerminalRunIds?: string[];
};
