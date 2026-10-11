import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
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
  paginateSessionMessages,
  readChatHistoryMessageSeq as resolveMessageSeq,
  readIncrementalChatHistoryTail,
  resolveCursorSeq,
} from "./session-history-tail.js";
import type { SessionTranscriptReader } from "./session-transcript-read.types.js";
import { iterateSessionTranscriptSourcePages } from "./session-transcript-source-pages.js";

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
  let windowReset = false;
  let totalRawMessages: number | undefined;
  let transcriptPath: string | undefined;
  let projected: ReturnType<typeof projectChatDisplayMessagesWithState>;
  if (typeof params.limit !== "number") {
    rawMessages = [];
    for await (const page of iterateSessionTranscriptSourcePages(
      options.readers.readSessionMessagesWithSourceAsync.bind(options.readers),
      params.target,
      {
        allowResetArchiveFallback: true,
        readOnly: options.readOnly,
      },
    )) {
      rawMessages.push(...page.messages);
      transcriptPath = page.transcriptPath;
    }
    projected = projectChatDisplayMessagesWithState(rawMessages, {
      subagentCoordination: options.readers.subagentCoordination,
      includeCommentaryFallbacks: true,
      maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
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
    windowReset = tail.windowReset ?? false;
    projected = tail.projection;
    rawMessages = tail.rawMessages;
    totalRawMessages = tail.readPage.totalMessages;
    transcriptPath = tail.readPage.transcriptPath;
  }
  const rawHistoryMessages = rawMessages.filter(isRecord);
  const history = paginateSessionMessages(
    projected.messages,
    params.limit,
    windowReset ? undefined : params.cursor,
  );
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
    history: { ...history, ...(windowReset ? { windowReset: true } : {}) },
    rawTranscriptSeq:
      totalRawMessages ?? resolveMessageSeq(rawHistoryMessages.at(-1)) ?? rawHistoryMessages.length,
    turnBoundaryPending: projected.turnBoundaryPending,
    assistantErrorPending: projected.assistantErrorPending,
    transcriptPath,
  };
}
