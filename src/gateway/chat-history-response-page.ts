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
import { isTranscriptOnlyOpenClawAssistantModel } from "../shared/transcript-only-openclaw-assistant.js";
import { isNormalizedMessageChannel } from "../utils/message-channel-core.js";
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
  maxCost = Infinity,
) {
  const seq = readPageMessageSequence(messages[index], messageSequences);
  let start = index;
  let end = index + 1;
  let cost = messageCost(messages[index]);
  if (seq !== undefined) {
    while (start > 0 && readPageMessageSequence(messages[start - 1], messageSequences) === seq) {
      start -= 1;
      if (cost <= maxCost) {
        cost += messageCost(messages[start]);
      }
    }
    while (
      end < messages.length &&
      readPageMessageSequence(messages[end], messageSequences) === seq
    ) {
      if (cost <= maxCost) {
        cost += messageCost(messages[end]);
      }
      end += 1;
    }
  }
  return { start, end, cost, messages, sourceStart: start, sourceEnd: end };
}

function selectChatHistoryResponsePage(
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
) {
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
  const maxSingleMessageBytes = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxCost - 1);
  const prepareGroup = (index: number) => {
    const group = resolveChatHistoryMessageGroup(
      normalized,
      index,
      messageCost,
      messageSequences,
      maxCost,
    );
    let messages = normalized;
    // A source row is indivisible, including when its display siblings become a reference.
    if (group.cost > maxCost) {
      messages = [
        buildOversizedHistoryPlaceholder(
          normalized
            .slice(group.start, group.end)
            .find((message) => readChatHistoryMessageId(message) === messageId) ??
            normalized[group.end - 1],
        ),
      ];
    } else if (group.cost - 1 > maxSingleMessageBytes) {
      messages = normalized.slice(group.start, group.end);
    }
    if (messages !== normalized) {
      messages = replaceOversizedChatHistoryMessages({
        byteCounter,
        messages,
        maxSingleMessageBytes,
      }).messages;
    }
    group.messages = messages;
    if (messages !== normalized) {
      group.start = 0;
      group.end = messages.length;
    }
    return group;
  };
  // A metadata-free unavailable sentinel can split a source group. Walk the same
  // post-replacement groups as the eager path, but prepare only visited source rows.
  const walk = (
    initialSource: ReturnType<typeof prepareGroup>,
    initialIndex: number,
    direction: -1 | 1,
  ) => {
    let source = initialSource;
    let index = initialIndex;
    return () => {
      if (index < source.start || index >= source.end) {
        const next = direction === -1 ? source.sourceStart - 1 : source.sourceEnd;
        if (next < 0 || next >= normalized.length) {
          return undefined;
        }
        source = prepareGroup(next);
        index = direction === -1 ? source.end - 1 : source.start;
      }
      const group =
        source.messages === normalized
          ? source
          : resolveChatHistoryMessageGroup(source.messages, index, messageCost, messageSequences);
      index = direction === -1 ? group.start - 1 : group.end;
      return group;
    };
  };
  const older: unknown[] = [];
  const newer: unknown[] = [];
  let cost = 0;
  let byteLimited = false;
  const direction = messageId && historyPage.anchor?.direction;
  const index = direction
    ? direction === "newer"
      ? 0
      : normalized.length - 1
    : messageId
      ? normalized.findIndex((message) => readChatHistoryMessageId(message) === messageId)
      : normalized.length - 1;
  if (index >= 0 && index < normalized.length) {
    let source = prepareGroup(index);
    let anchorIndex = -1;
    if (messageId) {
      const anchorId = direction
        ? (readChatHistoryMessageId(
            direction === "newer" ? source.messages[source.start] : source.messages[source.end - 1],
          ) ?? messageId)
        : messageId;
      if (direction && anchorId === messageId) {
        const fallback = normalized.findIndex(
          (message) => readChatHistoryMessageId(message) === messageId,
        );
        if (fallback >= 0 && (fallback < source.sourceStart || fallback >= source.sourceEnd)) {
          source = prepareGroup(fallback);
        }
      }
      anchorIndex = source.messages.findIndex(
        (message) => readChatHistoryMessageId(message) === anchorId,
      );
    }
    const anchor =
      anchorIndex < 0
        ? undefined
        : resolveChatHistoryMessageGroup(
            source.messages,
            anchorIndex,
            messageCost,
            messageSequences,
          );
    if (messageId && !anchor) {
      byteLimited = true;
    } else if (anchor && !(anchor.cost <= maxCost)) {
      newer.push(source.messages[anchorIndex]);
      byteLimited =
        source.sourceStart > 0 ||
        source.sourceEnd < normalized.length ||
        source.end - source.start > 1;
    } else {
      if (anchor) {
        for (let cursor = anchor.start; cursor < anchor.end; cursor++) {
          newer.push(source.messages[cursor]);
        }
        cost = anchor.cost;
      }
      const before = walk(source, anchor ? anchor.start - 1 : source.end - 1, -1);
      const after = anchor ? walk(source, anchor.end, 1) : undefined;
      const grow = (iterator: ReturnType<typeof walk>, target: unknown[], reverse: boolean) => {
        const group = iterator();
        if (!group) {
          return false;
        }
        if (!(cost + group.cost <= maxCost)) {
          byteLimited = true;
          return false;
        }
        for (let cursor = group.start; cursor < group.end; cursor++) {
          target.push(group.messages[reverse ? group.end - 1 - (cursor - group.start) : cursor]);
        }
        cost += group.cost;
        return true;
      };
      let canGrowOlder = true;
      let canGrowNewer = Boolean(after);
      while (canGrowOlder || canGrowNewer) {
        canGrowOlder &&= grow(before, older, true);
        canGrowNewer &&= Boolean(after && grow(after, newer, false));
      }
    }
  } else {
    byteLimited = normalized.length > 0;
  }
  const capped =
    older.length + newer.length === normalized.length &&
    older.every((message, i) => message === normalized[older.length - 1 - i]) &&
    newer.every((message, i) => message === normalized[older.length + i])
      ? normalized
      : older.toReversed().concat(newer);
  return { normalized, activity, byteCounter, byteLimited, capped, responseHistoryBytes };
}

/** Scanning consumes the selection decision without composing a discarded wire response. */
export function isChatHistoryResponsePageByteLimited(
  ...args: Parameters<typeof selectChatHistoryResponsePage>
): boolean {
  const { normalized, byteLimited, capped } = selectChatHistoryResponsePage(...args);
  if (!byteLimited) {
    return false;
  }
  const survivors = new Set(capped);
  return normalized.some((message) => !survivors.has(message));
}

export function prepareChatHistoryResponsePage(
  ...args: Parameters<typeof selectChatHistoryResponsePage>
): ChatHistoryResponsePage {
  const [historyPage] = args;
  const { normalized, activity, byteCounter, byteLimited, capped, responseHistoryBytes } =
    selectChatHistoryResponsePage(...args);
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
        (!historyPage.anchor || historyPage.anchor.hasOlder || byteLimited)
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
            ...(byteLimited ? { byteLimited: true as const } : {}),
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
  // Bundled display adapters can exist without a running channel account.
  // Keep webchat on the worker-encoded fast path; channel views are viewer-bound.
  if (
    params.deferChannelUserDisplay &&
    page.messages.some((value) => {
      const message = asOptionalRecord(value);
      const transport = asOptionalRecord(asOptionalRecord(message?.["__openclaw"])?.transport);
      return (
        message?.role === "user" &&
        typeof transport?.channel === "string" &&
        typeof transport.accountId === "string" &&
        isNormalizedMessageChannel(transport.channel)
      );
    })
  ) {
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
  let modelRangeCount = 0;
  const encodeArray = (values: unknown[], modelRanges?: number[]) => {
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
      const start = offset;
      offset += encoder.encodeInto(part, bytes.subarray(offset)).written;
      const row = modelRanges && asOptionalRecord(values[index]);
      if (
        modelRanges &&
        row?.role === "assistant" &&
        (row.provider != null || row.model != null) &&
        !isTranscriptOnlyOpenClawAssistantModel(row.provider, row.model)
      ) {
        modelRanges[modelRangeCount++] = start;
        modelRanges[modelRangeCount++] = offset;
      }
    }
    bytes[offset] = 0x5d;
    return bytes;
  };
  const ranges: number[] = [];
  ranges.length = response.messages.length * 2;
  const messages = encodeArray(response.messages, ranges);
  ranges.length = modelRangeCount;
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
    messageModelIndex: {
      byteLength: messages.byteLength,
      rowCount: response.messages.length,
      ranges,
    },
    encodedResponse: {
      ...response,
      messages,
      activity,
    },
  };
}
