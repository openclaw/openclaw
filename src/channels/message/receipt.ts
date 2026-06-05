/**
 * Channel message receipt normalization.
 *
 * Builds stable receipts from platform send results and nested adapter receipt data.
 */
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type {
  MessageReceipt,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";

type MessageReceiptInputResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
};

export type MessageReceiptDeliveryEvidence = {
  /** Whether the receipt includes concrete platform ids from an accepted send. */
  platformSendAccepted: boolean;
  /** Timestamp when the channel adapter produced platform send-acceptance evidence. */
  platformSendAcceptedAt: number | null;
  /** Platform ids returned by the adapter/provider for the accepted send, if any. */
  platformMessageIds: string[];
  /** Explains whether the receipt contains platform evidence or only local receipt metadata. */
  platformSendEvidence: "platform_message_ids" | "none";
  /**
   * Message receipts are not read receipts. Device-visible delivery must be
   * confirmed by a channel-specific receipt/read path, not inferred from ids.
   */
  deviceDeliveryConfirmed: false;
  deviceDeliveryEvidence: "not_tracked_by_message_receipt";
};

function resolveReceiptMessageId(result: MessageReceiptInputResult): string | undefined {
  return (
    result.messageId ||
    result.chatId ||
    result.channelId ||
    result.roomId ||
    result.conversationId ||
    result.toJid ||
    result.pollId
  );
}

function hasNestedReceiptData(receipt: MessageReceipt | undefined): receipt is MessageReceipt {
  return Boolean(
    receipt &&
    (receipt.parts.length > 0 ||
      receipt.platformMessageIds.length > 0 ||
      receipt.primaryPlatformMessageId),
  );
}

function appendUnique(values: string[], value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

/** Builds one normalized receipt from platform send results or nested adapter receipts. */
export function createMessageReceiptFromOutboundResults(params: {
  results: readonly MessageReceiptInputResult[];
  kind?: MessageReceiptPartKind;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): MessageReceipt {
  const parts = params.results.flatMap((result, resultIndex) => {
    if (hasNestedReceiptData(result.receipt)) {
      // Preserve adapter-supplied receipt parts first; only fill missing thread/reply metadata.
      return result.receipt.parts.length > 0
        ? result.receipt.parts.map((part, partIndex) => ({
            ...part,
            index: part.index ?? partIndex,
            ...(part.threadId || !params.threadId ? {} : { threadId: params.threadId }),
            ...(part.replyToId || !params.replyToId ? {} : { replyToId: params.replyToId }),
          }))
        : result.receipt.platformMessageIds.map((platformMessageId, partIndex) => ({
            platformMessageId,
            kind: params.kind ?? "unknown",
            index: partIndex,
            ...(params.threadId ? { threadId: params.threadId } : {}),
            ...(params.replyToId ? { replyToId: params.replyToId } : {}),
          }));
    }
    const platformMessageId = resolveReceiptMessageId(result);
    if (!platformMessageId) {
      return [];
    }
    return [
      {
        platformMessageId,
        kind: params.kind ?? "unknown",
        index: resultIndex,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        raw: result,
      },
    ];
  });
  const platformMessageIds: string[] = [];
  for (const result of params.results) {
    if (hasNestedReceiptData(result.receipt)) {
      appendUnique(platformMessageIds, result.receipt.primaryPlatformMessageId);
      for (const platformMessageId of result.receipt.platformMessageIds) {
        appendUnique(platformMessageIds, platformMessageId);
      }
      for (const part of result.receipt.parts) {
        appendUnique(platformMessageIds, part.platformMessageId);
      }
      continue;
    }
    appendUnique(platformMessageIds, resolveReceiptMessageId(result));
  }
  const firstNestedReceipt = params.results.find((result) =>
    hasNestedReceiptData(result.receipt),
  )?.receipt;
  return {
    ...(platformMessageIds[0] ? { primaryPlatformMessageId: platformMessageIds[0] } : {}),
    platformMessageIds,
    parts,
    ...((params.threadId ?? firstNestedReceipt?.threadId)
      ? { threadId: params.threadId ?? firstNestedReceipt?.threadId }
      : {}),
    ...((params.replyToId ?? firstNestedReceipt?.replyToId)
      ? { replyToId: params.replyToId ?? firstNestedReceipt?.replyToId }
      : {}),
    sentAt: params.sentAt ?? firstNestedReceipt?.sentAt ?? Date.now(),
    raw: params.results,
  };
}

/** Lists unique platform message ids in receipt order. */
export function listMessageReceiptPlatformIds(receipt: MessageReceipt): string[] {
  return normalizeUniqueStringEntries(receipt.platformMessageIds);
}

/** Resolves the explicit primary platform id, falling back to the first unique receipt id. */
export function resolveMessageReceiptPrimaryId(receipt: MessageReceipt): string | undefined {
  const primary = receipt.primaryPlatformMessageId?.trim();
  if (primary) {
    return primary;
  }
  return listMessageReceiptPlatformIds(receipt)[0];
}

/** Summarizes what a receipt proves without upgrading send acceptance into device delivery. */
export function createMessageReceiptDeliveryEvidence(
  receipt: MessageReceipt,
): MessageReceiptDeliveryEvidence {
  const platformMessageIds = listMessageReceiptPlatformIds(receipt);
  const hasPlatformSendEvidence = platformMessageIds.length > 0;
  return {
    platformSendAccepted: hasPlatformSendEvidence,
    platformSendAcceptedAt: hasPlatformSendEvidence ? receipt.sentAt : null,
    platformMessageIds,
    platformSendEvidence: hasPlatformSendEvidence ? "platform_message_ids" : "none",
    deviceDeliveryConfirmed: false,
    deviceDeliveryEvidence: "not_tracked_by_message_receipt",
  };
}
