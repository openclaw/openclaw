import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryResponsePage,
} from "../../config/sessions/session-history-types.js";
import {
  readChatHistoryMessageId,
  readChatHistoryMessageSeq,
  readChatHistoryPaginationKey,
} from "../session-history-tail.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  buildOversizedHistoryPlaceholder,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "./chat-history-budget.js";
import { resolveChatHistoryPageCursors } from "./chat-history-page-cursor.js";
type MessageSequences = Record<string, number> | ((message: unknown) => number | undefined);

function readPageMessageSequence(message: unknown, messageSequences?: MessageSequences) {
  if (typeof messageSequences === "function") {
    return messageSequences(message);
  }
  return (
    messageSequences?.[readChatHistoryPaginationKey(message) ?? ""] ??
    readChatHistoryMessageSeq(message)
  );
}

function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
  messageSequences?: MessageSequences;
}): number {
  const sequence = (message: unknown) => readPageMessageSequence(message, params.messageSequences);
  let oldestSeq: number | undefined;
  for (const message of params.messages) {
    oldestSeq = sequence(message);
    if (oldestSeq !== undefined) {
      break;
    }
  }
  if (oldestSeq === undefined) {
    return params.offset + params.rawPageMessages;
  }
  const recordOffset = params.totalMessages - oldestSeq + 1;
  // Every selected source row is complete, inline or by reference.
  return Math.max(params.offset + 1, recordOffset);
}

/** Preserve token metrics saved by pre-removal builds; new markers own their metrics. */
export function enrichChatHistoryCompactionMarkers(
  messages: unknown[],
  entry: ChatHistoryPageParams["entry"],
  metrics = readLegacyCompactionMetrics(entry),
): unknown[] {
  if (metrics.length === 0) {
    return messages;
  }
  const checkpointByEntryId = new Map(metrics.map((metric) => [metric.entryId, metric]));
  let changed = false;
  const enriched = messages.map((message) => {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    if (metadata?.kind !== "compaction" || typeof metadata.id !== "string") {
      return message;
    }
    const checkpoint = checkpointByEntryId.get(metadata.id);
    if (!checkpoint) {
      return message;
    }
    const tokensBefore = checkpoint.tokensBefore;
    const tokensAfter = checkpoint.tokensAfter;
    if (tokensBefore === undefined && tokensAfter === undefined) {
      return message;
    }
    changed = true;
    return {
      ...record,
      __openclaw: {
        ...metadata,
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      },
    };
  });
  return changed ? enriched : messages;
}

function resolveChatHistoryMessageGroup(
  messages: unknown[],
  index: number,
  messageCost: (message: unknown) => number,
  messageSequences?: MessageSequences,
): { start: number; end: number; cost: number } {
  const sequence = (message: unknown) => readPageMessageSequence(message, messageSequences);
  const seq = sequence(messages[index]);
  let start = index;
  let end = index + 1;
  let cost = messageCost(messages[index]);
  if (seq === undefined) {
    return { start, end, cost };
  }
  while (start > 0 && sequence(messages[start - 1]) === seq) {
    start -= 1;
    cost += messageCost(messages[start]);
  }
  while (end < messages.length && sequence(messages[end]) === seq) {
    cost += messageCost(messages[end]);
    end += 1;
  }
  return { start, end, cost };
}

function capChatHistoryTail(params: {
  messages: unknown[];
  maxCost: number;
  messageCost: (message: unknown) => number;
  messageSequences?: MessageSequences;
}): unknown[] {
  let start = params.messages.length;
  let cost = 0;
  while (start > 0) {
    const group = resolveChatHistoryMessageGroup(
      params.messages,
      start - 1,
      params.messageCost,
      params.messageSequences,
    );
    if (cost + group.cost > params.maxCost) {
      break;
    }
    start = group.start;
    cost += group.cost;
  }
  return start > 0 ? params.messages.slice(start) : params.messages;
}

function capChatHistoryAroundMessage(params: {
  messages: unknown[];
  messageId: string;
  maxCost: number;
  messageCost?: (message: unknown) => number;
  messageSequences?: MessageSequences;
}): unknown[] {
  const anchorIndex = params.messages.findIndex(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
  if (anchorIndex === -1) {
    return [];
  }
  const messageCost = params.messageCost ?? (() => 1);
  const groupAt = (index: number) =>
    resolveChatHistoryMessageGroup(params.messages, index, messageCost, params.messageSequences);
  const anchorGroup = groupAt(anchorIndex);
  if (!(anchorGroup.cost <= params.maxCost)) {
    return [params.messages[anchorIndex]];
  }

  let { start, end, cost } = anchorGroup;
  let canGrowOlder = start > 0;
  let canGrowNewer = end < params.messages.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      const olderGroup = groupAt(start - 1);
      if (cost + olderGroup.cost <= params.maxCost) {
        start = olderGroup.start;
        cost += olderGroup.cost;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder &&= start > 0;

    if (canGrowNewer) {
      const newerGroup = groupAt(end);
      if (cost + newerGroup.cost <= params.maxCost) {
        end = newerGroup.end;
        cost += newerGroup.cost;
      } else {
        canGrowNewer = false;
      }
    }
    canGrowNewer &&= end < params.messages.length;
  }
  return params.messages.slice(start, end);
}

export function prepareChatHistoryResponsePage(
  historyPage: ChatHistoryPage,
  {
    entry: historyEntry,
    compactionMetrics,
    maxHistoryBytes,
    responseHistoryBytes = maxHistoryBytes,
    messageId,
  }: Pick<
    ChatHistoryPageParams,
    "entry" | "compactionMetrics" | "maxHistoryBytes" | "responseHistoryBytes" | "messageId"
  >,
  messageSequences: MessageSequences | undefined = historyPage.pagination?.messageSequences ??
    historyPage.anchor?.messageSequences,
): ChatHistoryResponsePage {
  const normalized = enrichChatHistoryCompactionMarkers(
    historyPage.messages,
    historyEntry,
    compactionMetrics,
  );
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity);
  const framingCost = 1 + byteCounter.framingBytes(normalized);
  const maxCost = responseHistoryBytes - framingCost;
  const messageCost = (message: unknown) => byteCounter.messageBytes(message) + 1;
  const groups: unknown[] = [];
  for (let index = 0; index < normalized.length;) {
    const group = resolveChatHistoryMessageGroup(normalized, index, messageCost, messageSequences);
    // A source row is the fetchable unit; replacing its display siblings keeps
    // numeric offsets lossless without letting one row escape the page budget.
    groups.push(
      ...(group.cost > maxCost
        ? [
            buildOversizedHistoryPlaceholder(
              normalized
                .slice(group.start, group.end)
                .find((message) => readChatHistoryMessageId(message) === messageId) ??
                normalized[group.end - 1],
            ),
          ]
        : normalized.slice(group.start, group.end)),
    );
    index = group.end;
  }
  const replaced = replaceOversizedChatHistoryMessages({
    byteCounter,
    messages: groups,
    maxSingleMessageBytes: Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxCost - 1),
  });
  const capParams = { messages: replaced.messages, maxCost, messageCost, messageSequences };
  const capped = messageId
    ? capChatHistoryAroundMessage({
        ...capParams,
        messageId: historyPage.anchor?.direction
          ? (readChatHistoryMessageId(
              historyPage.anchor.direction === "newer"
                ? replaced.messages[0]
                : replaced.messages.at(-1),
            ) ?? messageId)
          : messageId,
      })
    : capChatHistoryTail(capParams);
  const pagination = historyPage.pagination;
  const candidateNextOffset =
    pagination === undefined
      ? undefined
      : resolveChatHistoryNextOffset({
          messages: capped,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          messageSequences: pagination.messageSequences,
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? candidateNextOffset < pagination.totalMessages
      : undefined;
  const survivors = new Set(capped);
  const omittedCount = normalized.reduce<number>(
    (count, message) => count + (survivors.has(message) ? 0 : 1),
    0,
  );
  return {
    messages: composeTranscriptDisplay(capped),
    ...(capped.some((message) => activity.has(message))
      ? { activity: capped.flatMap((message) => activity.get(message) ?? []) }
      : {}),
    messagesBytes: byteCounter.messagesBytes(capped),
    ...(omittedCount > 0
      ? {
          omission: {
            omittedCount,
            normalizedBytes: byteCounter.messagesBytes(normalized),
            ...(capped.length < replaced.messages.length ? { byteLimited: true as const } : {}),
          },
        }
      : {}),
    responseHistoryBytes,
    ...resolveChatHistoryPageCursors(historyPage.anchor, capped, normalized),
    ...(hasMore ? { nextOffset: candidateNextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(pagination !== undefined ? { totalMessages: pagination.totalMessages } : {}),
  };
}

export function encodeChatHistoryResponsePage(
  page: ChatHistoryPage,
  params: ChatHistoryPageParams,
): ChatHistoryPage {
  if (!params.encodeResponse) {
    return page;
  }
  const response = prepareChatHistoryResponsePage(page, params);
  return {
    ...page,
    messages: [],
    activity: undefined,
    encodedResponse: {
      ...response,
      messages: new TextEncoder().encode(JSON.stringify(response.messages)),
    },
  };
}
