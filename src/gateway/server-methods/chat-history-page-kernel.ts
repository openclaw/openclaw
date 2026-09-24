import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readLegacyCompactionHistory } from "../../config/sessions/legacy-compaction-history.js";
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
import type { CurrentUserProfileDisplayResolver } from "../current-user-profile-display.types.js";
import {
  capOffsetChatHistoryProjectedMessages,
  dropChatHistoryOverreadContextMessage,
  readChatHistoryMessageId,
  readChatHistoryRecoveryContext,
  readChatHistoryMessageSeq,
  readIncrementalChatHistoryTail,
  type IncrementalChatHistoryTail,
} from "../session-history-tail.js";
import type {
  SessionTranscriptReader,
  ReadRecentSessionMessagesResult,
  SessionTranscriptReadScope,
} from "../session-transcript-read-kernel.js";

type ChatHistoryCliTail = {
  readScope: SessionTranscriptReadScope;
  incrementalTail: IncrementalChatHistoryTail;
  activeLeafEntryId: string | null;
  buildTailPage: (messages: unknown[]) => ChatHistoryPage;
};
export type ChatHistoryPageKernelOptions = {
  readers: SessionTranscriptReader;
  readOnly?: boolean;
  deferProfileDisplay?: boolean;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: ChatDisplayProjectionOptions["resolveCronJobName"];
  cliSessionId?: string;
  readCliTailPage?: (tail: ChatHistoryCliTail) => Promise<ChatHistoryPage>;
};

export function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  projected: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
}): number {
  let oldestSeq: number | undefined;
  let boundedSiblings = 0;
  for (const message of params.messages) {
    const seq = readChatHistoryMessageSeq(message);
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
      if (readChatHistoryMessageSeq(message) === oldestSeq) {
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
): unknown[] {
  let checkpoints: ReturnType<typeof readLegacyCompactionHistory>;
  try {
    checkpoints = readLegacyCompactionHistory(entry);
  } catch {
    // Corrupt legacy metadata cannot hide readable transcript history.
    return messages;
  }
  if (checkpoints.length === 0) {
    return messages;
  }
  const checkpointByEntryId = new Map(
    checkpoints.flatMap((checkpoint) => {
      const entryId = checkpoint.postCompaction.entryId;
      return entryId ? [[entryId, checkpoint] as const] : [];
    }),
  );
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
  const cliSessionId = options.cliSessionId;
  // Bound snapshots are terminal by contract, so offset requests return the same
  // full snapshot. Paging oversized imports needs an opaque snapshot cursor and
  // is deferred to a follow-up issue. Anchored reads fall through with them: the
  // full-snapshot merge below still centers on messageId at the handler cap.
  if ((offset !== undefined || messageId) && !cliSessionId) {
    let pageOffset = offset ?? 0;
    let hasOverreadContext = false;
    let readPage: ReadRecentSessionMessagesResult;
    let incrementalTail: IncrementalChatHistoryTail | undefined;
    if (messageId) {
      const anchoredPage = await options.readers.readSessionMessagesAroundIdWithStatsAsync(
        readScope,
        {
          messageId,
          maxMessages: max,
          allowResetArchiveFallback: true,
          readOnly: options.readOnly,
        },
      );
      if (!anchoredPage.found) {
        return { messages: [] };
      }
      pageOffset = anchoredPage.offset;
      hasOverreadContext = anchoredPage.hasOverreadContext;
      readPage = anchoredPage;
    } else {
      incrementalTail = await readIncrementalChatHistoryTail({
        entry,
        readScope,
        effectiveMaxChars,
        max,
        maxBytes: maxHistoryBytes,
        offset: pageOffset,
        ...options,
      });
      readPage = incrementalTail.readPage;
    }
    const isTailPage = !messageId && pageOffset === 0;
    const overreadContextMessage = incrementalTail
      ? incrementalTail.overreadContextMessage
      : hasOverreadContext || readPage.messages.length > max
        ? readPage.messages[0]
        : undefined;
    const localMessages = incrementalTail
      ? incrementalTail.rawMessages
      : dropChatHistoryOverreadContextMessage(
          dropPreSessionStartAnnouncePairs(
            readPage.messages,
            typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
          ),
          overreadContextMessage,
        );
    const rawPageMessages = incrementalTail
      ? incrementalTail.rawPageMessages
      : Math.min(
          max,
          Math.max(readPage.messages.length, readPage.totalMessages > pageOffset ? 1 : 0),
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
    const projection = incrementalTail?.projection ?? project(localMessages);
    let projected = incrementalTail?.projected ?? projection.messages;
    const newestPageSeq = readChatHistoryMessageSeq(localMessages.at(-1));
    if (
      !incrementalTail &&
      pageOffset > 0 &&
      newestPageSeq !== undefined &&
      projection.assistantErrorPending
    ) {
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
      });
      if (recoveryContext.length > 0) {
        projected = project([...localMessages, ...recoveryContext]).messages.filter(
          (message) => (readChatHistoryMessageSeq(message) ?? Infinity) <= newestPageSeq,
        );
      }
    }
    const windowed = messageId
      ? capChatHistoryAroundMessage({
          messages: projected,
          messageId,
          maxCost: max,
        })
      : projected;
    if (messageId) {
      // Numeric offsets do not encode the selected historical transcript source.
      return {
        messages: augmentChatHistoryWithCanvasBlocks(windowed),
        ...(projection.activity.length ? { activity: projection.activity } : {}),
      };
    }
    return {
      ...(isTailPage
        ? {
            activeLeafEntryId: resolveChatHistoryActiveLeafEntryId(readPage),
            ...(readPage.transcriptSource === "active" &&
            readPage.deltaCursor &&
            !incrementalTail?.projection.assistantErrorPending
              ? { deltaCursor: readPage.deltaCursor }
              : {}),
          }
        : {}),
      messages: augmentChatHistoryWithCanvasBlocks(windowed),
      ...(projection.activity.length ? { activity: projection.activity } : {}),
      responseOffset: pageOffset,
      pagination: {
        offset: pageOffset,
        totalMessages: readPage.totalMessages,
        rawPageMessages,
      },
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
  const activeLeafEntryId = resolveChatHistoryActiveLeafEntryId(readPage);
  const buildTailPage = (messages: unknown[]): ChatHistoryPage => {
    const windowedTailMessages =
      offset === undefined
        ? messages.length > max
          ? messages.slice(-max)
          : messages
        : capOffsetChatHistoryProjectedMessages(messages, max);
    return {
      activeLeafEntryId,
      ...(readPage.transcriptSource === "active" &&
      readPage.deltaCursor &&
      !incrementalTail.projection.assistantErrorPending
        ? { deltaCursor: readPage.deltaCursor }
        : {}),
      messages: augmentChatHistoryWithCanvasBlocks(windowedTailMessages),
      ...(incrementalTail.projection.activity.length
        ? { activity: incrementalTail.projection.activity }
        : {}),
      pagination: {
        offset: offset ?? 0,
        totalMessages: readPage.totalMessages,
        rawPageMessages: incrementalTail.rawPageMessages,
      },
    };
  };
  return options.readCliTailPage
    ? options.readCliTailPage({ readScope, incrementalTail, activeLeafEntryId, buildTailPage })
    : buildTailPage(incrementalTail.projected);
}
