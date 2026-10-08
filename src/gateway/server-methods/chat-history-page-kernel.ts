import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../../config/sessions/session-history-types.js";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../config/sessions/transcript-tree.js";
import { createTranscriptDisplaySource } from "../../sessions/transcript-display-position.js";
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
  readChatHistoryRecoveryContext,
  readChatHistoryMessageSeq,
  readIncrementalChatHistoryTail,
} from "../session-history-tail.js";
import type {
  SessionTranscriptPageReader,
  ReadRecentSessionMessagesResult,
} from "../session-transcript-read.types.js";
import { attachChatHistoryReplyMessages } from "./chat-history-reply-messages.js";
import { prepareChatHistoryResponsePage } from "./chat-history-response-page.js";

export type ChatHistoryPageKernelOptions = {
  readers: SessionTranscriptPageReader;
  readOnly?: boolean;
  deferProfileDisplay?: boolean;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: ChatDisplayProjectionOptions["resolveCronJobName"];
  readMessageSequence?: (message: unknown) => number | undefined;
};

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
    pageCursor,
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
    const direction = pageCursor?.direction;
    const readPage = await options.readers.readSessionMessagesAroundIdWithStatsAsync(readScope, {
      messageId,
      // Directional pages exclude the anchor; older pages also need preceding turn context.
      maxMessages: max + (direction === "older" ? 2 : direction === "newer" ? 1 : 0),
      direction,
      allowResetArchiveFallback: true,
      readOnly: options.readOnly,
    });
    const source = readPage.displaySource
      ? createTranscriptDisplaySource([readPage.displaySource])
      : undefined;
    if (pageCursor && (!readPage.found || readPage.windowReset || source !== pageCursor.source)) {
      return { messages: [], windowReset: true };
    }
    if (!readPage.found) {
      return { messages: [] };
    }
    let pageMessages = readPage.messages;
    let overreadContextMessage = readPage.hasOverreadContext ? pageMessages[0] : undefined;
    if (direction) {
      const anchorIndex = pageMessages.findIndex(
        (message) => readChatHistoryMessageId(message) === messageId,
      );
      if (anchorIndex < 0) {
        return { messages: [], windowReset: true };
      }
      const anchorSeq = readSequence(pageMessages[anchorIndex]);
      let start = anchorIndex;
      let end = anchorIndex + 1;
      if (anchorSeq !== undefined) {
        while (start > 0 && readSequence(pageMessages[start - 1]) === anchorSeq) {
          start -= 1;
        }
        while (end < pageMessages.length && readSequence(pageMessages[end]) === anchorSeq) {
          end += 1;
        }
      }
      if (direction === "newer") {
        overreadContextMessage = pageMessages[end - 1];
        pageMessages = pageMessages.slice(end - 1);
      } else {
        pageMessages = pageMessages.slice(0, start);
        const firstSeq = readSequence(pageMessages[0]);
        if (anchorSeq !== undefined && firstSeq !== undefined && anchorSeq - firstSeq > max) {
          overreadContextMessage = pageMessages[0];
          pageMessages = [
            overreadContextMessage,
            ...pageMessages.filter((message) => readSequence(message) !== firstSeq),
          ];
        }
      }
    }
    const localMessages = dropChatHistoryOverreadContextMessage(
      dropPreSessionStartAnnouncePairs(
        pageMessages,
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
    if (
      (direction === "older" || readPage.offset > 0) &&
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
        sessionStartedAt: entry?.sessionStartedAt,
      });
      if (recoveryContext.length > 0) {
        projected = project([...localMessages, ...recoveryContext]).messages.filter(
          (message) => (readSequence(message) ?? Infinity) <= newestPageSeq,
        );
      }
    }
    const cursorMessages = dropChatHistoryOverreadContextMessage(
      pageMessages,
      overreadContextMessage,
    );
    const oldestSeq = readSequence(cursorMessages[0]);
    return {
      messages: await attachChatHistoryReplyMessages(
        augmentChatHistoryWithCanvasBlocks(projected),
        params,
        options,
      ),
      ...(projection.activity.length ? { activity: projection.activity } : {}),
      ...(source
        ? {
            anchor: {
              sessionId,
              source,
              direction,
              hasOlder: direction === "newer" || (oldestSeq !== undefined && oldestSeq > 1),
              hasNewer: direction === "older" || readPage.offset > 0,
              oldestMessageId: readChatHistoryMessageId(cursorMessages[0]),
              newestMessageId: readChatHistoryMessageId(cursorMessages.at(-1)),
            },
          }
        : {}),
    };
  }

  const incrementalTail = await readIncrementalChatHistoryTail({
    entry,
    readScope,
    effectiveMaxChars,
    max,
    maxBytes: maxHistoryBytes,
    isPageFull: (projection) =>
      prepareChatHistoryResponsePage(projection, params, options.readMessageSequence).omission
        ?.byteLimited === true,
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
