import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
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
import type { CurrentUserProfileDisplayResolver } from "./current-user-profile-display.types.js";
import type {
  SessionTranscriptReader,
  ReadRecentSessionMessagesResult,
  SessionTranscriptReadScope,
} from "./session-transcript-read-kernel.js";

const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES = 8_000;
const SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES = 100;
const SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_CHUNK_MESSAGES = 400;

export function readChatHistoryMessageId(message: unknown): string | undefined {
  const id = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
  return typeof id === "string" && id ? id : undefined;
}

export function readChatHistoryMessageSeq(message: unknown): number | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return asPositiveSafeInteger(metadata?.seq);
}

export function capOffsetChatHistoryProjectedMessages(messages: unknown[], max: number): unknown[] {
  if (messages.length <= max) {
    return messages;
  }
  const start = Math.max(0, messages.length - max);
  const boundarySeq = readChatHistoryMessageSeq(messages[start]);
  if (boundarySeq === undefined) {
    return messages.slice(start);
  }
  // Numeric cursors resume at transcript records, so projected siblings stay together.
  let safeStart = start;
  while (safeStart > 0 && readChatHistoryMessageSeq(messages[safeStart - 1]) === boundarySeq) {
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
  overreadContextMessage: unknown;
  projection: ReturnType<typeof projectChatDisplayMessagesWithState>;
  projected: unknown[];
  rawMessages: unknown[];
  rawPageMessages: number;
  readPage: ReadRecentSessionMessagesResult;
};

async function readAdjacentChatHistoryMessages(params: {
  anchorId: string;
  direction: "older" | "newer";
  limit: number;
  readScope: SessionTranscriptReadScope;
  readers: SessionTranscriptReader;
  displaySource: string | undefined;
  expectedReadWindow?: TranscriptReadWindow;
  readOnly?: boolean;
}): Promise<unknown[]> {
  // Anchor lookup and positioning share one snapshot; numeric offsets drift on appends.
  const page = await params.readers.readSessionMessagesAroundIdWithStatsAsync(params.readScope, {
    messageId: params.anchorId,
    maxMessages: params.limit + 1,
    direction: params.direction,
    expectedReadWindow: params.expectedReadWindow,
    allowResetArchiveFallback: true,
    readOnly: params.readOnly,
  });
  if (!page.found || page.displaySource !== params.displaySource) {
    throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);
  }
  const anchorIndex = page.messages.findIndex(
    (message) => readChatHistoryMessageId(message) === params.anchorId,
  );
  if (anchorIndex < 0) {
    throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);
  }
  return params.direction === "newer"
    ? page.messages.slice(anchorIndex + 1, anchorIndex + 1 + params.limit)
    : page.messages.slice(Math.max(0, anchorIndex - params.limit), anchorIndex);
}

/** Resolve only the newer turn context a historical page needs to classify its pending error. */
export async function readChatHistoryRecoveryContext(params: {
  messages: unknown[];
  createRecovery: (messages: unknown[]) => {
    append: (messages: unknown[]) => void;
    readonly pending: boolean;
  };
  readScope: SessionTranscriptReadScope;
  readers: SessionTranscriptReader;
  displaySource: string | undefined;
  expectedReadWindow?: TranscriptReadWindow;
  maxBytes: number;
  readOnly?: boolean;
}): Promise<unknown[]> {
  const context: unknown[] = [];
  let recovery: ReturnType<typeof params.createRecovery> | undefined;
  let anchorId = readChatHistoryMessageId(params.messages.at(-1));
  let scannedBytes = 0;
  while (anchorId && context.length < SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES) {
    const chunkSize = Math.min(
      SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES,
      SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES - context.length,
    );
    const newer = await readAdjacentChatHistoryMessages({
      anchorId,
      direction: "newer",
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
      scannedBytes += Buffer.byteLength(JSON.stringify(message), "utf8");
      if (scannedBytes > params.maxBytes) {
        return context;
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
    anchorId = readChatHistoryMessageId(context.at(-1));
  }
  return context;
}

/** Scans indexed transcript records until one bounded visible history page is filled. */
export async function readIncrementalChatHistoryTail(params: {
  entry: SessionEntry | undefined;
  readScope: SessionTranscriptReadScope;
  readers: SessionTranscriptReader;
  effectiveMaxChars: number;
  max: number;
  maxBytes: number;
  offset?: number;
  beforeSeq?: number;
  preserveProjectionContext?: boolean;
  readOnly?: boolean;
  deferProfileDisplay?: boolean;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: ChatDisplayProjectionOptions["resolveCronJobName"];
}): Promise<IncrementalChatHistoryTail> {
  const { resolveCurrentUserProfileDisplay } = params;
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
          maxBytes: Math.max(params.maxBytes * 2, 1024 * 1024),
          allowResetArchiveFallback: true,
          captureReadWindow: true,
          readOnly: params.readOnly,
        })
      : await params.readers.readSessionMessagesPageWithStatsAsync(params.readScope, {
          offset,
          ...(requestedBeforeSeq === undefined ? {} : { beforeSeq: requestedBeforeSeq }),
          maxMessages: initialMessages + 1,
          ...(requestedBeforeSeq !== undefined && params.preserveProjectionContext
            ? {
                recentAtHead: {
                  maxMessages: rawHistoryWindowMessages + 1,
                  maxLines: rawHistoryWindowMessages + 1,
                  maxBytes: Math.max(params.maxBytes * 2, 1024 * 1024),
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
  const newestPageSeq = readChatHistoryMessageSeq(rawMessages.at(-1));
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
        (message) => (readChatHistoryMessageSeq(message) ?? Infinity) <= (newestPageSeq ?? -1),
      );
    }
    const projected =
      offset === 0
        ? projection.messages.length > params.max
          ? projection.messages.slice(-params.max)
          : projection.messages
        : capOffsetChatHistoryProjectedMessages(projection.messages, params.max);
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
        if (sessionStartedAt === undefined) {
          recovery.append(messages);
          return recovery;
        }
        const filter = createPreSessionStartAnnouncePairFilter(sessionStartedAt);
        let contextRemoved = overreadContextMessage === undefined;
        const append = (chunk: unknown[]) => {
          const filtered = filter(chunk);
          const prepared = contextRemoved
            ? filtered
            : dropChatHistoryOverreadContextMessage(filtered, overreadContextMessage);
          contextRemoved ||= prepared.length !== filtered.length;
          recovery.append(prepared);
        };
        append(
          overreadContextMessage === undefined ? messages : [overreadContextMessage, ...messages],
        );
        return {
          append,
          get pending() {
            return recovery.pending;
          },
        };
      },
      readScope: params.readScope,
      readers: params.readers,
      displaySource: readPage.displaySource,
      expectedReadWindow: readWindow,
      maxBytes: params.maxBytes,
      readOnly: params.readOnly,
    });
    return project();
  };
  let result = await projectWindow();
  let estimatedVisibleMessages = result.projected.length;
  let projectionDirty = false;
  let scanLimit = rawHistoryWindowMessages;
  let scannedBytes = 0;
  const unmeasuredPages: unknown[][] = [];
  let nextChunkMessages = SILENT_CHAT_HISTORY_TAIL_SCAN_CHUNK_MESSAGES;
  while (rawPageMessages < availableMessages) {
    if (projectionDirty && estimatedVisibleMessages >= params.max) {
      result = await projectWindow();
      projectionDirty = false;
      estimatedVisibleMessages = result.projected.length;
    }
    if (result.projected.length >= params.max) {
      break;
    }
    if (rawPageMessages >= rawHistoryWindowMessages) {
      scanLimit = rawHistoryWindowMessages + SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES;
    }
    if (rawPageMessages >= scanLimit) {
      break;
    }
    const chunkMessages = Math.min(nextChunkMessages, scanLimit - rawPageMessages);
    const oldestId = readChatHistoryMessageId(rawMessages[0]);
    const page =
      offset > 0 && recoveryContext !== undefined && oldestId
        ? {
            ...readPage,
            messages: await readAdjacentChatHistoryMessages({
              anchorId: oldestId,
              direction: "older",
              limit: chunkMessages + 1,
              readScope: params.readScope,
              readers: params.readers,
              displaySource: readPage.displaySource,
              expectedReadWindow: readWindow,
              readOnly: params.readOnly,
            }),
          }
        : await params.readers.readSessionMessagesPageWithStatsAsync(params.readScope, {
            beforeSeq,
            offset: rawPageMessages,
            expectedReadWindow: readWindow,
            maxMessages: chunkMessages + 1,
            allowResetArchiveFallback: true,
            readOnly: params.readOnly,
          });
    // Separate awaits may cross a destructive rewrite, even when a page is empty.
    // Let the existing retryable history response request one coherent snapshot.
    if (page.displaySource !== readPage.displaySource) {
      throw new SessionTranscriptProjectionUnavailableError(params.readScope.sessionId);
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
    // Count fresh rows once; the authoritative whole-window projection preserves cross-chunk facts.
    estimatedVisibleMessages += project(chunkRawMessages, contextMessage, false, []).projection
      .messages.length;
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
