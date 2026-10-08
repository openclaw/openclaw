import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PaginatedSessionHistory,
  SessionHistoryMessage,
} from "../config/sessions/session-history-types.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveTranscriptPageEnd } from "../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindow } from "../sessions/transcript-read-window.js";
import {
  projectChatDisplayMessagesWithState,
  type ChatDisplayProjectionOptions,
  createChatHistoryRecoveryProjection,
} from "./chat-display-projection.core.js";
import {
  dropPreSessionStartAnnouncePairs,
  isHeartbeatHistoryTurnBoundaryMessage,
  createPreSessionStartAnnouncePairFilter,
} from "./chat-display-projection.history.js";
import type { CurrentUserProfileDisplayResolver } from "./current-user-profile-display.js";
import type {
  SessionTranscriptPageReader,
  ReadRecentSessionMessagesResult,
  SessionTranscriptReadScope,
} from "./session-transcript-read.types.js";

const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES = 8_000;
const SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES = 100;
const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES = 400;
const HISTORY_PAGE_MAX_BYTES = 1024 * 1024;

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

export function readChatHistoryMessageId(message: unknown): string | undefined {
  const id = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
  return typeof id === "string" && id ? id : undefined;
}

export function readChatHistoryMessageSeq(message: unknown): number | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return asPositiveSafeInteger(metadata?.seq);
}

export function readChatHistoryPaginationKey(message: unknown): string | undefined {
  const id = readChatHistoryMessageId(message);
  if (id) {
    return `id:${id}`;
  }
  const seq = readChatHistoryMessageSeq(message);
  return seq === undefined ? undefined : `seq:${seq}`;
}

function capOffsetChatHistoryProjectedMessages(
  messages: unknown[],
  max: number,
  sequence = readChatHistoryMessageSeq,
): unknown[] {
  if (messages.length <= max) {
    return messages;
  }
  const start = Math.max(0, messages.length - max);
  const boundarySeq = sequence(messages[start]);
  if (boundarySeq === undefined) {
    return messages.slice(start);
  }
  // Numeric cursors resume at transcript records, so projected siblings stay together.
  let safeStart = start;
  while (safeStart > 0 && sequence(messages[safeStart - 1]) === boundarySeq) {
    safeStart--;
  }
  return messages.slice(safeStart);
}

export function dropChatHistoryOverreadContextMessage(
  messages: unknown[],
  contextMessage: unknown,
): unknown[] {
  if (contextMessage === undefined) {
    return messages;
  }
  const index = messages.indexOf(contextMessage);
  return index < 0 ? messages : [...messages.slice(0, index), ...messages.slice(index + 1)];
}

export type IncrementalChatHistoryTail = {
  windowReset?: boolean;
  overreadContextMessage: unknown;
  projection: ReturnType<typeof projectChatDisplayMessagesWithState>;
  projected: unknown[];
  rawMessages: unknown[];
  rawPageMessages: number;
  readPage: ReadRecentSessionMessagesResult;
};

async function readNewerChatHistoryMessages(params: {
  anchorId: string;
  limit: number;
  readScope: SessionTranscriptReadScope;
  readers: SessionTranscriptPageReader;
  displaySource: string | undefined;
  expectedReadWindow?: TranscriptReadWindow;
  readOnly?: boolean;
}): Promise<unknown[]> {
  // Anchor lookup and positioning share one snapshot; numeric offsets drift on appends.
  const page = await params.readers.readSessionMessagesAroundIdWithStatsAsync(params.readScope, {
    messageId: params.anchorId,
    maxMessages: params.limit + 1,
    direction: "newer",
    expectedReadWindow: params.expectedReadWindow,
    allowResetArchiveFallback: true,
    readOnly: params.readOnly,
  });
  if (page.windowReset || !page.found || page.displaySource !== params.displaySource) {
    throw new SessionTranscriptProjectionUnavailableError(
      params.readScope.sessionId,
      "window-changed",
    );
  }
  const anchorIndex = page.messages.findIndex(
    (message) => readChatHistoryMessageId(message) === params.anchorId,
  );
  if (anchorIndex < 0) {
    throw new SessionTranscriptProjectionUnavailableError(
      params.readScope.sessionId,
      "window-changed",
    );
  }
  return page.messages.slice(anchorIndex + 1, anchorIndex + 1 + params.limit);
}

/** Resolve only the newer turn context a historical page needs to classify its pending error. */
export async function readChatHistoryRecoveryContext(params: {
  messages: unknown[];
  createRecovery: (messages: unknown[]) => {
    append: (messages: unknown[]) => void;
    readonly pending: boolean;
  };
  readScope: SessionTranscriptReadScope;
  readers: SessionTranscriptPageReader;
  displaySource: string | undefined;
  expectedReadWindow?: TranscriptReadWindow;
  maxBytes: number;
  readOnly?: boolean;
  sessionStartedAt?: number;
}): Promise<unknown[]> {
  const context: unknown[] = [];
  const filterAnnounces = createPreSessionStartAnnouncePairFilter(params.sessionStartedAt);
  let recovery: ReturnType<typeof params.createRecovery> | undefined;
  let anchorId = readChatHistoryMessageId(params.messages.at(-1));
  let scannedBytes = 0;
  let scannedMessages = 0;
  while (anchorId && scannedMessages < SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES) {
    const chunkSize = Math.min(
      SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES,
      SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES - scannedMessages,
    );
    const newer = await readNewerChatHistoryMessages({
      anchorId,
      limit: chunkSize,
      readScope: params.readScope,
      readers: params.readers,
      displaySource: params.displaySource,
      expectedReadWindow: params.expectedReadWindow,
      readOnly: params.readOnly,
    });
    if (newer.length === 0) {
      break;
    }
    const previousContextLength = context.length;
    let boundaryReached = false;
    for (const message of newer) {
      scannedMessages++;
      scannedBytes += Buffer.byteLength(JSON.stringify(message), "utf8");
      if (scannedBytes > params.maxBytes) {
        return context;
      }
      // Hidden rows still consume the scan budget and advance the next indexed anchor.
      anchorId = readChatHistoryMessageId(message);
      if (filterAnnounces([message]).length === 0) {
        continue;
      }
      context.push(message);
      if (asOptionalRecord(message)?.role === "user") {
        boundaryReached = true;
        break;
      }
    }
    if (boundaryReached) {
      break;
    }
    recovery ??= params.createRecovery(params.messages);
    recovery.append(context.slice(previousContextLength));
    if (!recovery.pending) {
      break;
    }
  }
  return context;
}

/** Scans indexed transcript records until one bounded visible history page is filled. */
async function readIncrementalChatHistoryTailAttempt(params: {
  entry: SessionEntry | undefined;
  readScope: SessionTranscriptReadScope;
  readers: SessionTranscriptPageReader;
  effectiveMaxChars: number;
  max: number;
  maxBytes: number;
  offset?: number;
  beforeSeq?: number;
  preserveProjectionContext?: boolean;
  isPageFull?: (
    projection: Pick<
      ReturnType<typeof projectChatDisplayMessagesWithState>,
      "messages" | "activity"
    >,
  ) => boolean;
  readMessageSequence?: (message: unknown) => number | undefined;
  readOnly?: boolean;
  deferProfileDisplay?: boolean;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: ChatDisplayProjectionOptions["resolveCronJobName"];
}): Promise<IncrementalChatHistoryTail> {
  const { resolveCurrentUserProfileDisplay } = params;
  const readSequence = params.readMessageSequence ?? readChatHistoryMessageSeq;
  let offset = params.offset ?? 0;
  const requestedBeforeSeq = params.beforeSeq;
  const rawHistoryWindowMessages = Math.max(1, Math.floor(params.max)) * 20 + 20;
  // Sequence-cursor transports group tool results and derived mirrors together,
  // so their initial read keeps the established wider projection context.
  let initialMessages =
    requestedBeforeSeq !== undefined
      ? Math.min(rawHistoryWindowMessages, Math.max(1, params.max))
      : params.preserveProjectionContext && offset === 0
        ? rawHistoryWindowMessages
        : Math.min(
            rawHistoryWindowMessages,
            Math.max(1, offset === 0 ? params.max * 3 : params.max),
          );
  const readPage =
    offset === 0 && requestedBeforeSeq === undefined
      ? await params.readers.readRecentSessionMessagesWithStatsAsync(params.readScope, {
          maxMessages: initialMessages + 1,
          maxLines: initialMessages + 1,
          maxBytes: HISTORY_PAGE_MAX_BYTES,
          allowResetArchiveFallback: true,
          captureReadWindow: true,
          readOnly: params.readOnly,
        })
      : await params.readers.readSessionMessagesPageWithStatsAsync(params.readScope, {
          offset,
          ...(requestedBeforeSeq === undefined ? {} : { beforeSeq: requestedBeforeSeq }),
          maxMessages: initialMessages + 1,
          maxBytes: HISTORY_PAGE_MAX_BYTES,
          allowOversizedFirst: true,
          ...(requestedBeforeSeq !== undefined && params.preserveProjectionContext
            ? {
                recentAtHead: {
                  maxMessages: rawHistoryWindowMessages + 1,
                  maxLines: rawHistoryWindowMessages + 1,
                  maxBytes: HISTORY_PAGE_MAX_BYTES,
                },
              }
            : {}),
          allowResetArchiveFallback: true,
          captureReadWindow: true,
          readOnly: params.readOnly,
        });
  const readWindow = readPage.readWindow;
  const availableMessages = resolveTranscriptPageEnd(readPage.totalMessages, {
    beforeSeq: requestedBeforeSeq,
    offset,
  });
  // Every later read stays below this snapshot's head, including sparse offset and tail scans.
  const beforeSeq = availableMessages + 1;
  if (requestedBeforeSeq !== undefined) {
    offset = readPage.totalMessages - availableMessages;
    if (offset === 0 && params.preserveProjectionContext) {
      initialMessages = rawHistoryWindowMessages;
    }
  }
  const sessionStartedAt =
    typeof params.entry?.sessionStartedAt === "number" ? params.entry.sessionStartedAt : undefined;
  let rawPageMessages = Math.min(
    initialMessages,
    Math.max(readPage.messages.length, availableMessages > 0 ? 1 : 0),
  );
  let overreadContextMessage =
    readPage.messages.length > initialMessages ? readPage.messages[0] : undefined;
  let rawMessages = dropChatHistoryOverreadContextMessage(
    readPage.messages,
    overreadContextMessage,
  );
  let recoveryContext: unknown[] | undefined = offset === 0 ? [] : undefined;
  const newestPageSeq = readSequence(rawMessages.at(-1));
  const filterWindowMessages = (messages: unknown[], contextMessage: unknown) =>
    sessionStartedAt === undefined
      ? messages
      : dropChatHistoryOverreadContextMessage(
          dropPreSessionStartAnnouncePairs(
            contextMessage === undefined ? messages : [contextMessage, ...messages],
            sessionStartedAt,
          ),
          contextMessage,
        );
  const project = (
    messages = rawMessages,
    contextMessage = overreadContextMessage,
    resolveProfileDisplay = true,
    newerContext = recoveryContext ?? [],
  ) => {
    const filteredRawMessages = filterWindowMessages(messages, contextMessage);
    const projection = projectChatDisplayMessagesWithState(
      newerContext.length > 0 ? [...filteredRawMessages, ...newerContext] : filteredRawMessages,
      {
        subagentCoordination: params.readers.subagentCoordination,
        includeCommentaryFallbacks: true,
        maxChars: params.effectiveMaxChars,
        resolveCronJobName: params.resolveCronJobName,
        ...(resolveProfileDisplay && !params.deferProfileDisplay
          ? { resolveCurrentUserProfileDisplay }
          : {}),
        turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(contextMessage),
      },
    );
    if (newerContext.length > 0) {
      projection.messages = projection.messages.filter(
        (message) => (readSequence(message) ?? Infinity) <= (newestPageSeq ?? -1),
      );
    }
    const projected =
      offset === 0
        ? projection.messages.length > params.max
          ? projection.messages.slice(-params.max)
          : projection.messages
        : capOffsetChatHistoryProjectedMessages(projection.messages, params.max, readSequence);
    return { filteredRawMessages, projected, projection };
  };
  const projectWindow = async () => {
    const result = project();
    if (
      recoveryContext !== undefined ||
      newestPageSeq === undefined ||
      !result.projection.assistantErrorPending
    ) {
      return result;
    }
    recoveryContext = await readChatHistoryRecoveryContext({
      messages: result.filteredRawMessages,
      createRecovery: (messages) => {
        const recovery = createChatHistoryRecoveryProjection({
          subagentCoordination: params.readers.subagentCoordination,
          maxChars: params.effectiveMaxChars,
        });
        recovery.append(messages);
        return recovery;
      },
      readScope: params.readScope,
      readers: params.readers,
      displaySource: readPage.displaySource,
      expectedReadWindow: readWindow,
      maxBytes: params.maxBytes,
      readOnly: params.readOnly,
      sessionStartedAt,
    });
    return project();
  };
  let result = await projectWindow();
  let estimatedProjection: Pick<typeof result.projection, "messages" | "activity"> =
    result.projection;
  let projectionDirty = false;
  let scanLimit = rawHistoryWindowMessages;
  let scannedBytes = 0;
  const unmeasuredPages: unknown[][] = [];
  let nextChunkMessages = SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES;
  while (rawPageMessages < availableMessages) {
    if (
      projectionDirty &&
      (estimatedProjection.messages.length >= params.max ||
        params.isPageFull?.(estimatedProjection))
    ) {
      result = await projectWindow();
      projectionDirty = false;
      estimatedProjection = result.projection;
    }
    if (
      result.projected.length >= params.max ||
      (!projectionDirty && params.isPageFull?.(result.projection))
    ) {
      break;
    }
    if (rawPageMessages >= rawHistoryWindowMessages) {
      scanLimit = rawHistoryWindowMessages + SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES;
    }
    if (rawPageMessages >= scanLimit) {
      break;
    }
    const chunkMessages = Math.min(nextChunkMessages, scanLimit - rawPageMessages);
    const page = await params.readers.readSessionMessagesPageWithStatsAsync(params.readScope, {
      beforeSeq,
      offset: rawPageMessages,
      expectedReadWindow: readWindow,
      maxMessages: chunkMessages + 1,
      maxBytes: HISTORY_PAGE_MAX_BYTES,
      // Preserve an indivisible event; the next snapshot resumes before it.
      allowOversizedFirst: true,
      allowResetArchiveFallback: true,
      readOnly: params.readOnly,
    });
    // Separate awaits may cross a destructive rewrite, even when a page is empty.
    // Restart assembly instead of mixing records from different windows.
    if (page.windowReset || page.displaySource !== readPage.displaySource) {
      throw new SessionTranscriptProjectionUnavailableError(
        params.readScope.sessionId,
        "window-changed",
      );
    }
    if (page.messages.length === 0) {
      break;
    }
    // One older context row preserves stale-pair and heartbeat boundaries across chunks.
    const contextMessage = page.messages.length > chunkMessages ? page.messages[0] : undefined;
    const chunkRawMessages = dropChatHistoryOverreadContextMessage(page.messages, contextMessage);
    rawPageMessages += chunkRawMessages.length;
    rawMessages = chunkRawMessages.concat(rawMessages);
    overreadContextMessage = contextMessage;
    // Estimate with fresh rows; only the whole-window projection can finish the page.
    const chunkProjection = project(chunkRawMessages, contextMessage, false, []).projection;
    estimatedProjection = {
      messages: chunkProjection.messages.concat(estimatedProjection.messages),
      activity: chunkProjection.activity.concat(estimatedProjection.activity),
    };
    projectionDirty = true;
    unmeasuredPages.push(page.messages);
    if (rawPageMessages > rawHistoryWindowMessages) {
      // The byte guard only bounds the extended sparse scan. Preserve its exact
      // accounting without serializing pages that already fill the ordinary window.
      for (const messages of unmeasuredPages) {
        scannedBytes += Buffer.byteLength(JSON.stringify(messages), "utf8");
      }
      unmeasuredPages.length = 0;
      if (scannedBytes >= params.maxBytes) {
        break;
      }
    }
    // Grow sparse scans geometrically while bounding each indexed page's allocation.
    nextChunkMessages = Math.min(
      nextChunkMessages * 2,
      SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES,
    );
  }
  if (projectionDirty) {
    result = await projectWindow();
  }
  params.readers.subagentCoordination?.assertCurrent?.();
  return {
    overreadContextMessage,
    projected: result.projected,
    projection: result.projection,
    rawMessages: result.filteredRawMessages,
    rawPageMessages,
    readPage,
  };
}

export async function readIncrementalChatHistoryTail(
  params: Parameters<typeof readIncrementalChatHistoryTailAttempt>[0],
): Promise<IncrementalChatHistoryTail> {
  try {
    return await readIncrementalChatHistoryTailAttempt(params);
  } catch (error) {
    if (
      !(error instanceof SessionTranscriptProjectionUnavailableError) ||
      error.reason !== "window-changed"
    ) {
      throw error;
    }
    return {
      ...(await readIncrementalChatHistoryTailAttempt({
        ...params,
        offset: 0,
        beforeSeq: undefined,
      })),
      windowReset: true,
    };
  }
}
