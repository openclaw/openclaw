import type {
  PaginatedSessionHistory,
  SessionHistoryMessage,
  SessionHistoryReadParams,
  SessionHistorySnapshot,
} from "../config/sessions/session-history-types.js";
import {
  projectChatDisplayMessagesWithState,
  type ChatDisplayProjectionOptions,
} from "./chat-display-projection.core.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./chat-display-projection.helpers.js";
import type { CurrentUserProfileDisplayResolver } from "./current-user-profile-display.js";
import { getMaxChatHistoryMessagesBytes } from "./server-constants.js";
import {
  readChatHistoryMessageSeq as resolveMessageSeq,
  readIncrementalChatHistoryTail,
} from "./session-history-tail.js";
import type { SessionTranscriptReader } from "./session-transcript-read-kernel.js";

type SessionHistorySnapshotOptions = {
  readers: SessionTranscriptReader;
  readOnly?: boolean;
  deferProfileDisplay?: boolean;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: ChatDisplayProjectionOptions["resolveCronJobName"];
};

/** Keep raw scan context inside the worker; only the completed page crosses isolates. */
export async function readSessionHistorySnapshotKernel(
  params: SessionHistoryReadParams,
  options: SessionHistorySnapshotOptions,
): Promise<SessionHistorySnapshot> {
  let rawMessages: unknown[];
  let totalRawMessages: number | undefined;
  let transcriptPath: string | undefined;
  let projected: ReturnType<typeof projectChatDisplayMessagesWithState>;
  if (typeof params.limit !== "number") {
    const snapshot = await options.readers.readSessionMessagesWithSourceAsync(params.target, {
      mode: "full",
      reason: "session history cursor pagination",
      allowResetArchiveFallback: true,
      readOnly: options.readOnly,
    });
    rawMessages = snapshot.messages;
    transcriptPath = snapshot.transcriptPath;
    projected = projectChatDisplayMessagesWithState(rawMessages, {
      subagentCoordination: options.readers.subagentCoordination,
      includeCommentaryFallbacks: true,
      maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
      redactInlineMedia: true,
      resolveCronJobName: options.resolveCronJobName,
      ...(options.deferProfileDisplay
        ? {}
        : { resolveCurrentUserProfileDisplay: options.resolveCurrentUserProfileDisplay }),
    });
  } else {
    const cursorSeq = resolveCursorSeq(params.cursor);
    const tail = await readIncrementalChatHistoryTail({
      entry: params.target.sessionEntry,
      readScope: params.target,
      effectiveMaxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
      max: params.limit,
      maxBytes: getMaxChatHistoryMessagesBytes(),
      ...(cursorSeq === undefined ? {} : { beforeSeq: cursorSeq }),
      preserveProjectionContext: true,
      ...options,
    });
    projected = tail.projection;
    rawMessages = tail.rawMessages;
    totalRawMessages = tail.readPage.totalMessages;
    transcriptPath = tail.readPage.transcriptPath;
  }
  const rawHistoryMessages = toSessionHistoryMessages(rawMessages);
  const history = paginateSessionMessages(projected.messages, params.limit, params.cursor);
  if (
    typeof totalRawMessages === "number" &&
    totalRawMessages > rawMessages.length &&
    (!params.cursor || (resolveMessageSeq(rawHistoryMessages[0]) ?? 0) > 1)
  ) {
    const firstSeq = resolveMessageSeq(history.messages[0] ?? rawHistoryMessages[0]);
    history.hasMore = true;
    if (typeof firstSeq === "number") {
      history.nextCursor = String(firstSeq);
    }
  }
  return {
    history,
    rawTranscriptSeq:
      totalRawMessages ?? resolveMessageSeq(rawHistoryMessages.at(-1)) ?? rawHistoryMessages.length,
    turnBoundaryPending: projected.turnBoundaryPending,
    assistantErrorPending: projected.assistantErrorPending,
    transcriptPath,
  };
}

export function resolveCursorSeq(cursor: string | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }
  const normalized = cursor.startsWith("seq:") ? cursor.slice(4) : cursor;
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function toSessionHistoryMessages(messages: unknown[]): SessionHistoryMessage[] {
  return messages.filter(
    (message): message is SessionHistoryMessage =>
      Boolean(message) && typeof message === "object" && !Array.isArray(message),
  );
}

export function buildPaginatedSessionHistory(params: {
  messages: SessionHistoryMessage[];
  hasMore: boolean;
  nextCursor?: string;
}): PaginatedSessionHistory {
  return {
    items: params.messages,
    messages: params.messages,
    hasMore: params.hasMore,
    ...(params.nextCursor ? { nextCursor: params.nextCursor } : {}),
  };
}

function paginateSessionMessages(
  messages: SessionHistoryMessage[],
  limit: number | undefined,
  cursor: string | undefined,
): PaginatedSessionHistory {
  // Cursors point at transcript sequence watermarks. The returned page is the
  // window before that cursor, matching "older messages" pagination.
  const cursorSeq = resolveCursorSeq(cursor);
  let endExclusive = messages.length;
  if (typeof cursorSeq === "number") {
    endExclusive = messages.findIndex((message, index) => {
      const seq = resolveMessageSeq(message);
      if (typeof seq === "number") {
        return seq >= cursorSeq;
      }
      return index + 1 >= cursorSeq;
    });
    if (endExclusive < 0) {
      endExclusive = messages.length;
    }
  }
  let start = typeof limit === "number" && limit > 0 ? Math.max(0, endExclusive - limit) : 0;
  // Projection can interleave several rows from the same transcript records.
  // Close the page over their seq groups because the public cursor cannot split one.
  if (start > 0) {
    const pageSeqs = new Set<number>();
    let indexedStart = endExclusive;
    for (let index = start - 1; index >= 0; index--) {
      // Index only admitted intervals; unrelated older gaps need no retained sequence set.
      while (indexedStart > start) {
        const pageSeq = resolveMessageSeq(messages[--indexedStart]);
        if (pageSeq !== undefined) {
          pageSeqs.add(pageSeq);
        }
      }
      const seq = resolveMessageSeq(messages[index]);
      if (seq !== undefined && pageSeqs.has(seq)) {
        start = index;
      }
    }
  }
  const paginatedMessages = messages.slice(start, endExclusive);
  const firstSeq = resolveMessageSeq(paginatedMessages[0]);
  return buildPaginatedSessionHistory({
    messages: paginatedMessages,
    hasMore: start > 0,
    ...(start > 0 && typeof firstSeq === "number" ? { nextCursor: String(firstSeq) } : {}),
  });
}
