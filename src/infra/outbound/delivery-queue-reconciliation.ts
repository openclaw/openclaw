import type {
  ChannelMessageDurableFinalAdapter,
  ChannelMessageSendCommitContext,
  ChannelMessageUnknownSendReconciliationResult,
} from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { QueuedDelivery } from "./delivery-queue-storage.js";

export type UnknownSendReconciler = NonNullable<
  ChannelMessageDurableFinalAdapter["reconcileUnknownSend"]
>;

/** Resolves the adapter capability before replay pacing or reconciliation. */
export function resolveUnknownSendReconciler(
  entry: QueuedDelivery,
  cfg: OpenClawConfig,
): UnknownSendReconciler | null {
  const adapter = resolveOutboundChannelMessageAdapter({
    channel: entry.channel,
    cfg,
    allowBootstrap: true,
  });
  if (adapter?.durableFinal?.capabilities?.reconcileUnknownSend !== true) {
    return null;
  }
  return adapter.durableFinal.reconcileUnknownSend ?? null;
}

export async function reconcileUnknownQueuedDelivery(opts: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  log: { warn(msg: string): void };
  reconcile: UnknownSendReconciler;
}): Promise<ChannelMessageUnknownSendReconciliationResult> {
  const { entry } = opts;
  try {
    const result = await opts.reconcile({
      cfg: opts.cfg,
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
      payloads: entry.payloads,
      ...(entry.renderedBatchPlan ? { renderedBatchPlan: entry.renderedBatchPlan } : {}),
      ...(entry.replyToId !== undefined ? { replyToId: entry.replyToId } : {}),
      ...(entry.replyToMode !== undefined ? { replyToMode: entry.replyToMode } : {}),
      ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
      ...(entry.silent !== undefined ? { silent: entry.silent } : {}),
    });
    return (
      result ?? {
        status: "unresolved",
        error: "adapter returned no unknown-send reconciliation result",
        retryable: true,
      }
    );
  } catch (err) {
    const error = formatErrorMessage(err);
    opts.log.warn(`Delivery entry ${opts.entry.id} unknown-send reconciliation failed: ${error}`);
    return { status: "unresolved", error, retryable: true };
  }
}

export function buildReconciledSentResult(
  entry: QueuedDelivery,
  reconciliation: Extract<ChannelMessageUnknownSendReconciliationResult, { status: "sent" }>,
): OutboundDeliveryResult {
  return {
    channel: entry.channel,
    messageId:
      reconciliation.messageId ??
      reconciliation.receipt.primaryPlatformMessageId ??
      reconciliation.receipt.platformMessageIds[0] ??
      "",
    receipt: reconciliation.receipt,
  };
}

function buildReconciledCommitContext(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  result: OutboundDeliveryResult;
}): ChannelMessageSendCommitContext {
  const payload = params.entry.payloads[0] ?? {};
  const result = {
    messageId: params.result.messageId,
    receipt: params.result.receipt ?? {
      platformMessageIds: [params.result.messageId].filter(Boolean),
      parts: [],
      sentAt: Date.now(),
    },
  };
  const base = {
    cfg: params.cfg,
    to: params.entry.to,
    accountId: params.entry.accountId,
    replyToId:
      params.entry.effectiveReplyToId !== undefined
        ? params.entry.effectiveReplyToId
        : params.entry.replyToId,
    replyToMode: params.entry.replyToMode,
    threadId: params.entry.threadId,
    silent: params.entry.silent,
    result,
  };
  if (
    payload.presentation !== undefined ||
    payload.delivery !== undefined ||
    payload.interactive !== undefined ||
    (payload.channelData !== undefined && Object.keys(payload.channelData).length > 0)
  ) {
    return {
      ...base,
      kind: "payload",
      text: payload.text ?? "",
      mediaUrl: payload.mediaUrl,
      payload,
    };
  }
  const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.find((url) => url);
  if (mediaUrl) {
    return {
      ...base,
      kind: "media",
      text: payload.text ?? "",
      mediaUrl,
      audioAsVoice: payload.audioAsVoice,
      gifPlayback: params.entry.gifPlayback,
      forceDocument: params.entry.forceDocument,
    };
  }
  return {
    ...base,
    kind: "text",
    text: payload.text ?? "",
  };
}

export async function runReconciledSentCommitHooks(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  reconciliation: Extract<ChannelMessageUnknownSendReconciliationResult, { status: "sent" }>;
  log: { warn(msg: string): void };
}): Promise<void> {
  const adapter = resolveOutboundChannelMessageAdapter({
    channel: params.entry.channel,
    cfg: params.cfg,
    allowBootstrap: true,
  });
  const afterCommit = adapter?.send?.lifecycle?.afterCommit;
  if (!afterCommit) {
    return;
  }
  const result = buildReconciledSentResult(params.entry, params.reconciliation);
  try {
    await afterCommit(
      buildReconciledCommitContext({
        entry: params.entry,
        cfg: params.cfg,
        result,
      }),
    );
  } catch (err) {
    params.log.warn(
      `Delivery entry ${params.entry.id} reconciled sent afterCommit hook failed: ${formatErrorMessage(err)}`,
    );
  }
}
