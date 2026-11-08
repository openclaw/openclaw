import type { ReplyPayload } from "../../auto-reply/types.js";
import type {
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
} from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { isPermanentDeliveryError } from "./delivery-queue-recovery-policy.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

export function buildReconciledSentResult(
  entry: QueuedDelivery,
  reconciliation: Extract<ChannelMessageUnknownSendReconciliationResult, { status: "sent" }>,
) {
  return {
    channel: entry.channel,
    messageId:
      reconciliation.messageId ??
      reconciliation.receipt.primaryPlatformMessageId ??
      reconciliation.receipt.platformMessageIds[0] ??
      "",
    receipt: reconciliation.receipt,
  } satisfies OutboundDeliveryResult;
}

export function needsUnknownSendReconciliation(entry: QueuedDelivery): boolean {
  return (
    entry.recoveryState === "send_attempt_started" || entry.recoveryState === "unknown_after_send"
  );
}

type UnknownSendQueueEntry = Pick<
  QueuedDelivery,
  | "id"
  | "channel"
  | "to"
  | "accountId"
  | "enqueuedAt"
  | "retryCount"
  | "platformSendStartedAt"
  | "effectiveReplyToId"
  | "renderedBatchPlan"
  | "reply"
  | "threadId"
  | "silent"
  | "session"
>;

export function buildUnknownSendContext(params: {
  entry: UnknownSendQueueEntry;
  payloads: readonly ReplyPayload[];
  cfg: OpenClawConfig;
}): ChannelMessageUnknownSendContext {
  const { entry } = params;
  return {
    cfg: params.cfg,
    queueId: entry.id,
    channel: entry.channel,
    to: entry.to,
    ...(entry.accountId !== undefined ? { accountId: entry.accountId } : {}),
    enqueuedAt: entry.enqueuedAt,
    retryCount: entry.retryCount,
    ...(entry.platformSendStartedAt !== undefined
      ? { platformSendStartedAt: entry.platformSendStartedAt }
      : {}),
    ...(entry.effectiveReplyToId !== undefined
      ? { effectiveReplyToId: entry.effectiveReplyToId }
      : {}),
    payloads: params.payloads,
    ...(entry.renderedBatchPlan ? { renderedBatchPlan: entry.renderedBatchPlan } : {}),
    ...(entry.reply ? { replyToId: entry.reply.replyToId } : {}),
    ...(entry.reply?.source === "implicit" ? { replyToMode: entry.reply.mode } : {}),
    ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
    ...(entry.silent !== undefined ? { silent: entry.silent } : {}),
  };
}

/** Reconciles provider state without applying or rediscovering outbound policy. */
export async function reconcileUnknownQueuedDelivery(params: {
  entry: UnknownSendQueueEntry;
  payloads: readonly ReplyPayload[];
  cfg: OpenClawConfig;
  warn: (message: string) => void;
  assertCurrent?: () => void;
}): Promise<ChannelMessageUnknownSendReconciliationResult | null> {
  const adapter = await resolveOutboundChannelMessageAdapter({
    channel: params.entry.channel,
    cfg: params.cfg,
    agentId: params.entry.session?.agentId,
    allowBootstrap: true,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  const reconcileUnknownSend =
    adapter?.durableFinal?.capabilities?.reconcileUnknownSend === true
      ? adapter.durableFinal.reconcileUnknownSend
      : undefined;
  if (!reconcileUnknownSend) {
    return null;
  }
  const { entry } = params;
  try {
    return await reconcileUnknownSend(buildUnknownSendContext(params));
  } catch (error) {
    const message = formatErrorMessage(error);
    params.warn(`Delivery entry ${entry.id} unknown-send reconciliation failed: ${message}`);
    // A thrown reconciler gives no verdict on the send; classify it like a direct-send failure so a
    // permanent target error settles now instead of spending the retry budget.
    return { status: "unresolved", error: message, retryable: !isPermanentDeliveryError(message) };
  }
}
