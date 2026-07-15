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
  /** Durable pre/post boundary around the terminal external send. */
  restartRecoveryDeliveryReceiptState?: "terminal-pending" | "delivered-terminal";
  /** Exact agent tool call whose terminal external send owns the receipt. */
  restartRecoveryDeliveryToolCallId?: string;
  restartRecoveryDeliveryContext?: DeliveryContext;
  restartRecoveryDeliveryRequestFingerprint?: string;
  restartRecoveryDeliveryRunId?: string;
  restartRecoveryDeliverySourceRunId?: string;
  restartRecoveryRequesterAccountId?: string;
  restartRecoveryRequesterSenderId?: string;
  restartRecoverySameChannelThreadRequired?: true;
  restartRecoverySourceIngress?: "channel";
  restartRecoverySourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  restartRecoveryTerminalRunIds?: string[];
};
