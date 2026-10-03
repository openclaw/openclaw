import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../../config/sessions/session-history-types.js";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../config/sessions/transcript-tree.js";
import { augmentChatHistoryWithCanvasBlocks } from "../chat-display-projection.canvas.js";
import {
  projectChatDisplayMessagesWithState,
  createChatHistoryRecoveryProjection,
  type ChatDisplayProjectionOptions,
} from "../chat-display-projection.core.js";
import {
  dropPreSessionStartAnnouncePairs,
  isHeartbeatHistoryTurnBoundaryMessage,
} from "../chat-display-projection.history.js";
import type { CurrentUserProfileDisplayResolver } from "../current-user-profile-display.js";
import {
  dropChatHistoryOverreadContextMessage,
  readChatHistoryMessageId,
  readChatHistoryPaginationKey,
  readChatHistoryRecoveryContext,
  readChatHistoryMessageSeq,
  readIncrementalChatHistoryTail,
} from "../session-history-tail.js";
import type {
  SessionTranscriptPageReader,
  ReadRecentSessionMessagesResult,
} from "../session-transcript-read-kernel.js";
import { attachChatHistoryReplyMessages } from "./chat-history-reply-messages.js";

export type ChatHistoryPageKernelOptions = {
  readers: SessionTranscriptPageReader;
  readOnly?: boolean;
  deferProfileDisplay?: boolean;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: ChatDisplayProjectionOptions["resolveCronJobName"];
  readMessageSequence?: (message: unknown) => number | undefined;
};

export function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  projected: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
  messageSequences?: Record<string, number>;
}): number {
  const sequence = (message: unknown) =>
    params.messageSequences?.[readChatHistoryPaginationKey(message) ?? ""] ??
    readChatHistoryMessageSeq(message);
  let oldestSeq: number | undefined;
  let boundedSiblings = 0;
  for (const message of params.messages) {
    const seq = sequence(message);
    oldestSeq ??= seq;
    if (seq !== undefined && seq === oldestSeq) {
      boundedSiblings += 1;
    }
  }
  if (oldestSeq === undefined) {
    return params.offset + params.rawPageMessages;
  }
  const recordOffset = params.totalMessages - oldestSeq + 1;
  const replayOffset = recordOffset - 1;
  if (replayOffset > params.offset) {
    let projectedSiblings = 0;
    for (const message of params.projected) {
      if (sequence(message) === oldestSeq) {
        projectedSiblings += 1;
        if (projectedSiblings > boundedSiblings) {
          return replayOffset;
        }
      }
    }
  }
  // A replay cursor that does not advance strands every older transcript record.
  return Math.max(params.offset + 1, recordOffset);
}

function resolveChatHistoryActiveLeafEntryId(
  readPage: ReadRecentSessionMessagesResult,
): string | null {
  if (readPage.transcriptSource !== "active") {
    return null;
  }
  if (Object.hasOwn(readPage, "activeLeafEntryId")) {
    return readPage.activeLeafEntryId ?? null;
  }
  return resolveSessionTranscriptActiveLeafEntryId(readPage.transcriptEvents ?? []) ?? null;
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
): { start: number; end: number; cost: number } {
  const seq = readChatHistoryMessageSeq(messages[index]);
  let start = index;
  let end = index + 1;
  let cost = messageCost(messages[index]);
  if (seq === undefined) {
    return { start, end, cost };
  }
  while (start > 0 && readChatHistoryMessageSeq(messages[start - 1]) === seq) {
    start -= 1;
    cost += messageCost(messages[start]);
  }
  while (end < messages.length && readChatHistoryMessageSeq(messages[end]) === seq) {
    cost += messageCost(messages[end]);
    end += 1;
  }
  return { start, end, cost };
}

export function capChatHistoryAroundMessage(params: {
  messages: unknown[];
  messageId: string;
  maxCost: number;
  messageCost?: (message: unknown) => number;
}): unknown[] {
  const anchorIndex = params.messages.findIndex(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
  if (anchorIndex === -1) {
    return [];
  }
  const messageCost = params.messageCost ?? (() => 1);
  const anchorGroup = resolveChatHistoryMessageGroup(params.messages, anchorIndex, messageCost);
  if (!(anchorGroup.cost <= params.maxCost)) {
    return [params.messages[anchorIndex]];
  }

  let { start, end, cost } = anchorGroup;
  let canGrowOlder = start > 0;
  let canGrowNewer = end < params.messages.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      const olderGroup = resolveChatHistoryMessageGroup(params.messages, start - 1, messageCost);
      if (cost + olderGroup.cost <= params.maxCost) {
        start = olderGroup.start;
        cost += olderGroup.cost;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder &&= start > 0;

    if (canGrowNewer) {
      const newerGroup = resolveChatHistoryMessageGroup(params.messages, end, messageCost);
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

/** Assemble one page from admitted readers; host imports and profile discovery stay outside. */
export async function readChatHistoryPageKernel(
  params: ChatHistoryPageParams,
  options: ChatHistoryPageKernelOptions,
): Promise<ChatHistoryPage> {
  const {
    entry,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset,
    messageId,
  } = params;
  if (!sessionId || !storePath) {
    if (messageId) {
      return { messages: [] };
    }
    return {
      ...((offset ?? 0) === 0 ? { activeLeafEntryId: null } : {}),
      messages: [],
      ...(offset !== undefined ? { responseOffset: offset } : {}),
      pagination: { offset: offset ?? 0, totalMessages: 0, rawPageMessages: 0 },
    };
  }

  const readScope = {
    agentId: sessionAgentId,
    sessionEntry: entry,
    sessionId,
    sessionKey: canonicalKey,
    storePath,
  };
  const readSequence = options.readMessageSequence ?? readChatHistoryMessageSeq;
  if (messageId) {
    const readPage = await options.readers.readSessionMessagesAroundIdWithStatsAsync(readScope, {
      messageId,
      maxMessages: max,
      allowResetArchiveFallback: true,
      readOnly: options.readOnly,
    });
    if (!readPage.found) {
      return { messages: [] };
    }
    const overreadContextMessage =
      readPage.hasOverreadContext || readPage.messages.length > max
        ? readPage.messages[0]
        : undefined;
    const localMessages = dropChatHistoryOverreadContextMessage(
      dropPreSessionStartAnnouncePairs(
        readPage.messages,
        typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
      ),
      overreadContextMessage,
    );
    const project = (messages: unknown[]) =>
      projectChatDisplayMessagesWithState(messages, {
        subagentCoordination: options.readers.subagentCoordination,
        includeCommentaryFallbacks: true,
        maxChars: effectiveMaxChars,
        resolveCronJobName: options.resolveCronJobName,
        ...(options.deferProfileDisplay
          ? {}
          : { resolveCurrentUserProfileDisplay: options.resolveCurrentUserProfileDisplay }),
        turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage),
      });
    const projection = project(localMessages);
    let projected = projection.messages;
    const newestPageSeq = readSequence(localMessages.at(-1));
    if (readPage.offset > 0 && newestPageSeq !== undefined && projection.assistantErrorPending) {
      const recoveryContext = await readChatHistoryRecoveryContext({
        messages: localMessages,
        createRecovery: (messages) => {
          const recovery = createChatHistoryRecoveryProjection({
            maxChars: effectiveMaxChars,
            subagentCoordination: options.readers.subagentCoordination,
          });
          recovery.append(messages);
          return recovery;
        },
        readScope,
        readers: options.readers,
        displaySource: readPage.displaySource,
        maxBytes: maxHistoryBytes,
        readOnly: options.readOnly,
        sessionStartedAt: entry?.sessionStartedAt,
      });
      if (recoveryContext.length > 0) {
        projected = project([...localMessages, ...recoveryContext]).messages.filter(
          (message) => (readSequence(message) ?? Infinity) <= newestPageSeq,
        );
      }
    }
    // Numeric offsets do not encode the selected historical transcript source.
    return {
      messages: await attachChatHistoryReplyMessages(
        augmentChatHistoryWithCanvasBlocks(
          capChatHistoryAroundMessage({ messages: projected, messageId, maxCost: max }),
        ),
        params,
        options,
      ),
      ...(projection.activity.length ? { activity: projection.activity } : {}),
    };
  }

  const incrementalTail = await readIncrementalChatHistoryTail({
    entry,
    readScope,
    effectiveMaxChars,
    max,
    maxBytes: maxHistoryBytes,
    offset,
    ...options,
  });
  const { readPage } = incrementalTail;
  const currentOffset = incrementalTail.windowReset ? 0 : offset;
  const isOffsetPage = currentOffset !== undefined;
  const includeActiveLeaf = !isOffsetPage || currentOffset === 0;
  const activeLeafEntryId = includeActiveLeaf
    ? resolveChatHistoryActiveLeafEntryId(readPage)
    : null;
  return {
    ...(incrementalTail.windowReset ? { windowReset: true } : {}),
    ...(includeActiveLeaf ? { activeLeafEntryId } : {}),
    ...(includeActiveLeaf &&
    readPage.transcriptSource === "active" &&
    readPage.deltaCursor &&
    !incrementalTail.projection.assistantErrorPending
      ? { deltaCursor: readPage.deltaCursor }
      : {}),
    messages: await attachChatHistoryReplyMessages(
      augmentChatHistoryWithCanvasBlocks(incrementalTail.projected),
      params,
      options,
    ),
    ...(incrementalTail.projection.activity.length
      ? { activity: incrementalTail.projection.activity }
      : {}),
    ...(isOffsetPage ? { responseOffset: currentOffset } : {}),
    pagination: {
      offset: currentOffset ?? 0,
      totalMessages: readPage.totalMessages,
      rawPageMessages: incrementalTail.rawPageMessages,
    },
  };
}
