import { constants as zlibConstants, deflateRawSync } from "node:zlib";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { composeTranscriptDisplay } from "../chat/transcript-display-position.js";
import { readLegacyCompactionMetrics } from "../config/sessions/legacy-compaction-history.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryResponsePage,
} from "../config/sessions/session-history-types.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { mapChatDisplayMessages } from "./chat-display-projection.map.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  buildOversizedHistoryPlaceholder,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "./chat-history-budget.js";
import { resolveChatHistoryPageCursors } from "./chat-history-page-cursor.js";
import {
  readChatHistoryMessageId,
  readChatHistoryMessageSeq,
  readChatHistoryPaginationKey,
} from "./session-history-tail.js";
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
  return mapChatDisplayMessages(messages, (message) => {
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
    return {
      ...record,
      __openclaw: {
        ...metadata,
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      },
    };
  });
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
  measureJsonBytes = jsonUtf8Bytes,
): ChatHistoryResponsePage {
  const normalized = enrichChatHistoryCompactionMarkers(
    historyPage.messages,
    historyEntry,
    compactionMetrics,
  );
  const activity = createChatHistoryActivityProjection(normalized, historyPage.activity);
  const byteCounter = createChatHistoryByteCounter(activity, measureJsonBytes);
  const framingCost = 1 + byteCounter.framingBytes(normalized);
  const maxCost = responseHistoryBytes - framingCost;
  const messageCost = (message: unknown) => byteCounter.messageBytes(message) + 1;
  let groups: unknown[] | undefined;
  for (let index = 0; index < normalized.length;) {
    const group = resolveChatHistoryMessageGroup(normalized, index, messageCost, messageSequences);
    // A source row is the fetchable unit; replacing its display siblings keeps
    // numeric offsets lossless without letting one row escape the page budget.
    if (group.cost > maxCost) {
      groups ??= normalized.slice(0, group.start);
      groups.push(
        buildOversizedHistoryPlaceholder(
          normalized
            .slice(group.start, group.end)
            .find((message) => readChatHistoryMessageId(message) === messageId) ??
            normalized[group.end - 1],
        ),
      );
    } else if (groups) {
      for (let cursor = group.start; cursor < group.end; cursor++) {
        groups.push(normalized[cursor]);
      }
    }
    index = group.end;
  }
  const replaced = replaceOversizedChatHistoryMessages({
    byteCounter,
    messages: groups ?? normalized,
    maxSingleMessageBytes: Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxCost - 1),
  });
  const messages = replaced.messages;
  function capChatHistoryTail(): unknown[] {
    let start = messages.length;
    let cost = 0;
    while (start > 0) {
      const group = resolveChatHistoryMessageGroup(
        messages,
        start - 1,
        messageCost,
        messageSequences,
      );
      if (cost + group.cost > maxCost) {
        break;
      }
      start = group.start;
      cost += group.cost;
    }
    return start > 0 ? messages.slice(start) : messages;
  }

  function capChatHistoryAroundMessage(anchorMessageId: string): unknown[] {
    const anchorIndex = messages.findIndex(
      (message) => readChatHistoryMessageId(message) === anchorMessageId,
    );
    if (anchorIndex === -1) {
      return [];
    }
    const groupAt = (index: number) =>
      resolveChatHistoryMessageGroup(messages, index, messageCost, messageSequences);
    const anchorGroup = groupAt(anchorIndex);
    if (!(anchorGroup.cost <= maxCost)) {
      return [messages[anchorIndex]];
    }

    let { start, end, cost } = anchorGroup;
    const grow = (index: number) => {
      const group = groupAt(index);
      if (!(cost + group.cost <= maxCost)) {
        return false;
      }
      start = Math.min(start, group.start);
      end = Math.max(end, group.end);
      cost += group.cost;
      return true;
    };
    let canGrowOlder = start > 0;
    let canGrowNewer = end < messages.length;
    while (canGrowOlder || canGrowNewer) {
      canGrowOlder &&= grow(start - 1) && start > 0;
      canGrowNewer &&= grow(end) && end < messages.length;
    }
    return messages.slice(start, end);
  }
  const capped = messageId
    ? capChatHistoryAroundMessage(
        historyPage.anchor?.direction
          ? (readChatHistoryMessageId(
              historyPage.anchor.direction === "newer"
                ? replaced.messages[0]
                : replaced.messages.at(-1),
            ) ?? messageId)
          : messageId,
      )
    : capChatHistoryTail();
  const pagination = historyPage.pagination;
  let candidateNextOffset: number | undefined;
  if (pagination !== undefined) {
    let oldestSeq: number | undefined;
    for (const message of capped) {
      oldestSeq = readPageMessageSequence(message, pagination.messageSequences);
      if (oldestSeq !== undefined) {
        break;
      }
    }
    // Every selected source row is complete, inline or by reference.
    candidateNextOffset =
      oldestSeq === undefined
        ? pagination.offset + pagination.rawPageMessages
        : Math.max(pagination.offset + 1, pagination.totalMessages - oldestSeq + 1);
  }
  const cursors = resolveChatHistoryPageCursors(historyPage.anchor, capped, normalized);
  // Numeric pages may have no encodable IDs. Honor reader exhaustion unless
  // response budgeting dropped older source rows from this page.
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? candidateNextOffset < pagination.totalMessages &&
        (!historyPage.anchor || historyPage.anchor.hasOlder || capped.length < messages.length)
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
    ...cursors,
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
  // Budgeting and transport consume the same synchronous plain-data projection.
  // Keep its JSON only until this response is encoded, never across requests.
  const serialized = new Map<unknown, string | undefined>();
  const serialize = (value: unknown) => {
    if (!serialized.has(value)) {
      serialized.set(value, JSON.stringify(value));
    }
    return serialized.get(value);
  };
  const response = prepareChatHistoryResponsePage(page, params, undefined, (value) => {
    try {
      return Buffer.byteLength(serialize(value) ?? String(value), "utf8");
    } catch {
      return Buffer.byteLength(String(value), "utf8");
    }
  });
  const encoder = new TextEncoder();
  const encodeArray = (values: unknown[]) => {
    const parts = values.map((value) => serialize(value) ?? "null");
    const bytes = new Uint8Array(
      2 +
        Math.max(0, parts.length - 1) +
        parts.reduce((size, part) => size + Buffer.byteLength(part), 0),
    );
    bytes[0] = 0x5b;
    let offset = 1;
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        bytes[offset++] = 0x2c;
      }
      offset += encoder.encodeInto(part, bytes.subarray(offset)).written;
    }
    bytes[offset] = 0x5d;
    return bytes;
  };
  const messages = encodeArray(response.messages);
  const activity = response.activity ? encodeArray(response.activity) : undefined;
  return {
    ...page,
    messages: [],
    activity: undefined,
    // Paging maps have already become response cursors; do not clone them onto the host.
    pagination: undefined,
    anchor: undefined,
    // Own an exact ArrayBuffer so worker transfer never clones a pooled Buffer.
    encodedMessagesDeflate:
      params.deflateResponse && messages.byteLength >= 4 * 1024
        ? new Uint8Array(
            deflateRawSync(messages, { level: 1, finishFlush: zlibConstants.Z_SYNC_FLUSH }),
          )
        : undefined,
    encodedResponse: {
      ...response,
      messages,
      activity,
    },
  };
}
