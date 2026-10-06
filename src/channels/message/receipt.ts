import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeUniqueStringEntries,
  normalizeUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type {
  MessageReceipt,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";

type MessageReceiptInputResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
};

/** Reads reported recipients, including every physical part of an aggregate receipt. */
export function listMessageReceiptSourceTargets(value: unknown): string[] {
  const targets = new Set<string>();
  const seen = new Set<object>();
  const pending = [value];
  for (const entry of pending) {
    if (!entry || typeof entry !== "object" || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      pending.push(...entry);
      continue;
    }
    const record = asOptionalRecord(entry);
    if (!record || record.outcome === "not_sent") {
      continue;
    }
    const target = asOptionalRecord(record.target);
    const ids = [
      target?.id,
      ...(
        [
          "chatId",
          "channelId",
          "roomId",
          "conversationId",
          "toJid",
        ] as const satisfies readonly (keyof MessageReceiptSourceResult)[]
      ).map((key) => record[key]),
    ];
    for (const id of ids) {
      const normalized = normalizeOptionalString(id);
      if (normalized) {
        targets.add(normalized);
      }
    }
    pending.push(record.receipt, record.raw, record.parts);
  }
  return [...targets];
}

export function resolveReceiptSourceId(result: MessageReceiptInputResult): string | undefined {
  if (result.outcome === "not_sent") {
    return undefined;
  }
  return (
    normalizeOptionalString(result.messageId) ??
    (result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined) ??
    normalizeOptionalString(result.pollId)
  );
}

/** Builds one normalized receipt from platform send results or nested adapter receipts. */
export function createMessageReceiptFromOutboundResults(params: {
  results: readonly MessageReceiptInputResult[];
  kind?: MessageReceiptPartKind;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
}): MessageReceipt {
  const sentResults = params.results.filter((result) => result.outcome !== "not_sent");
  const requestedThreadId = normalizeOptionalString(params.threadId);
  const providerThreadIds = uniqueStrings(
    sentResults.flatMap(({ receipt }) =>
      receipt?.parts.length
        ? receipt.parts.flatMap(
            (part) =>
              normalizeOptionalString(part.threadId) ??
              normalizeOptionalString(receipt.threadId) ??
              [],
          )
        : (normalizeOptionalString(receipt?.threadId) ?? []),
    ),
  );
  const aggregateThreadId =
    providerThreadIds.length > 1 ? undefined : (providerThreadIds[0] ?? requestedThreadId);
  const parts = sentResults.flatMap((result, resultIndex) => {
    if (result.receipt) {
      const receiptThreadId = normalizeOptionalString(result.receipt.threadId) ?? requestedThreadId;
      if (result.receipt.parts.length === 0) {
        return result.receipt.platformMessageIds.map((platformMessageId, partIndex) => ({
          platformMessageId,
          kind: params.kind ?? "unknown",
          index: partIndex,
          ...(receiptThreadId ? { threadId: receiptThreadId } : {}),
          ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        }));
      }
      // Mixed adapter-supplied reply metadata is authoritative: missing entries mean
      // those physical messages were not native replies and must not inherit the route reply.
      const hasPartReplyMetadata = result.receipt.parts.some((part) => part.replyToId);
      return result.receipt.parts.map((part, partIndex) => ({
        ...part,
        index: part.index ?? partIndex,
        ...(normalizeOptionalString(part.threadId) || !receiptThreadId
          ? {}
          : { threadId: receiptThreadId }),
        ...(part.replyToId || !params.replyToId || hasPartReplyMetadata
          ? {}
          : { replyToId: params.replyToId }),
      }));
    }
    const platformMessageId = resolveReceiptSourceId(result);
    if (!platformMessageId) {
      return [];
    }
    return [
      {
        platformMessageId,
        kind: params.kind ?? "unknown",
        index: resultIndex,
        ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        raw: result,
      },
    ];
  });
  const platformMessageIds = normalizeUniqueTrimmedStringList(
    sentResults.flatMap((result) =>
      result.receipt
        ? [
            result.receipt.primaryPlatformMessageId,
            ...result.receipt.platformMessageIds,
            ...result.receipt.parts.map((part) => part.platformMessageId),
          ]
        : [resolveReceiptSourceId(result)],
    ),
  );
  const firstNestedReceipt = sentResults.find((result) => result.receipt)?.receipt;
  return {
    ...(platformMessageIds[0] ? { primaryPlatformMessageId: platformMessageIds[0] } : {}),
    platformMessageIds,
    parts,
    ...(aggregateThreadId ? { threadId: aggregateThreadId } : {}),
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
  const primary = normalizeOptionalString(receipt.primaryPlatformMessageId);
  if (primary) {
    return primary;
  }
  return (
    listMessageReceiptPlatformIds(receipt)[0] ??
    receipt.parts.map((part) => normalizeOptionalString(part.platformMessageId)).find(Boolean)
  );
}

/** Resolves provider-owned thread placement without collapsing conflicting receipt parts. */
export function resolveMessageReceiptThreadId(
  receipt: MessageReceipt,
  requestedThreadId?: string,
): string | undefined {
  const partThreadIds = uniqueStrings(
    receipt.parts.flatMap((part) => normalizeOptionalString(part.threadId) ?? []),
  );
  if (partThreadIds.length > 1) {
    return undefined;
  }
  return (
    partThreadIds[0] ??
    normalizeOptionalString(receipt.threadId) ??
    normalizeOptionalString(requestedThreadId)
  );
}
