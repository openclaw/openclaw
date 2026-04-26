import type { EmotionMode } from "../emotion-mode.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  projectChatDisplayMessages,
} from "./chat-display-projection.js";
import { attachOpenClawTranscriptMeta, readSessionMessages } from "./session-utils.js";

type SessionHistoryTranscriptMeta = {
  seq?: number;
};

export type SessionHistoryMessage = Record<string, unknown> & {
  __openclaw?: SessionHistoryTranscriptMeta;
};

export type PaginatedSessionHistory = {
  items: SessionHistoryMessage[];
  messages: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore: boolean;
};

export type SessionHistorySnapshot = {
  history: PaginatedSessionHistory;
  rawTranscriptSeq: number;
};

type SessionHistoryTranscriptTarget = {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
};

function resolveCursorSeq(cursor: string | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }
  const normalized = cursor.startsWith("seq:") ? cursor.slice(4) : cursor;
  const value = Number.parseInt(normalized, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function toSessionHistoryMessages(messages: unknown[]): SessionHistoryMessage[] {
  return messages.filter(
    (message): message is SessionHistoryMessage =>
      Boolean(message) && typeof message === "object" && !Array.isArray(message),
  );
}

function buildPaginatedSessionHistory(params: {
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

export function resolveMessageSeq(message: SessionHistoryMessage | undefined): number | undefined {
  const seq = message?.__openclaw?.seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

export function paginateSessionMessages(
  messages: SessionHistoryMessage[],
  limit: number | undefined,
  cursor: string | undefined,
): PaginatedSessionHistory {
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
  const start = typeof limit === "number" && limit > 0 ? Math.max(0, endExclusive - limit) : 0;
  const paginatedMessages = messages.slice(start, endExclusive);
  const firstSeq = resolveMessageSeq(paginatedMessages[0]);
  return buildPaginatedSessionHistory({
    messages: paginatedMessages,
    hasMore: start > 0,
    ...(start > 0 && typeof firstSeq === "number" ? { nextCursor: String(firstSeq) } : {}),
  });
}

export function buildSessionHistorySnapshot(params: {
  rawMessages: unknown[];
  maxChars?: number;
  limit?: number;
  cursor?: string;
  emotionMode?: EmotionMode;
}): SessionHistorySnapshot {
  const visibleMessages = toSessionHistoryMessages(
    projectChatDisplayMessages(params.rawMessages, {
      maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
      emotionMode: params.emotionMode,
    }),
  );
  const history = paginateSessionMessages(visibleMessages, params.limit, params.cursor);
  const rawHistoryMessages = toSessionHistoryMessages(params.rawMessages);
  return {
    history,
    rawTranscriptSeq: resolveMessageSeq(rawHistoryMessages.at(-1)) ?? rawHistoryMessages.length,
  };
}

export class SessionHistorySseState {
  private readonly target: SessionHistoryTranscriptTarget;
  private readonly maxChars: number;
  private readonly limit: number | undefined;
  private readonly cursor: string | undefined;
  private readonly resolveEmotionMode?: () => EmotionMode;
  private emotionMode: EmotionMode;
  private sentHistory: PaginatedSessionHistory;
  private rawTranscriptSeq: number;

  static fromRawSnapshot(params: {
    target: SessionHistoryTranscriptTarget;
    rawMessages: unknown[];
    maxChars?: number;
    limit?: number;
    cursor?: string;
    emotionMode?: EmotionMode;
    resolveEmotionMode?: () => EmotionMode;
  }): SessionHistorySseState {
    return new SessionHistorySseState({
      target: params.target,
      maxChars: params.maxChars,
      limit: params.limit,
      cursor: params.cursor,
      emotionMode: params.emotionMode,
      resolveEmotionMode: params.resolveEmotionMode,
      initialRawMessages: params.rawMessages,
    });
  }

  constructor(params: {
    target: SessionHistoryTranscriptTarget;
    maxChars?: number;
    limit?: number;
    cursor?: string;
    emotionMode?: EmotionMode;
    resolveEmotionMode?: () => EmotionMode;
    initialRawMessages?: unknown[];
  }) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    this.cursor = params.cursor;
    this.resolveEmotionMode = params.resolveEmotionMode;
    this.emotionMode = this.resolveEmotionMode?.() ?? params.emotionMode ?? "off";
    const rawMessages = params.initialRawMessages ?? this.readRawMessages();
    const snapshot = buildSessionHistorySnapshot({
      rawMessages,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
      emotionMode: this.emotionMode,
    });
    this.sentHistory = snapshot.history;
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
  }

  /**
   * Re-resolve the current per-session emotion mode on every snapshot/refresh.
   * Per Greptile P2 (session-history-state.ts:127): the original PR froze
   * `emotionMode` at construction time, so a `/emotions full` typed mid-stream
   * would not affect an open SSE history connection. Reading via
   * `resolveEmotionMode()` lets the gateway feed the latest persisted value
   * from the session store on every projection.
   */
  private getCurrentEmotionMode(): EmotionMode {
    this.emotionMode = this.resolveEmotionMode?.() ?? this.emotionMode;
    return this.emotionMode;
  }

  snapshot(): PaginatedSessionHistory {
    return this.sentHistory;
  }

  appendInlineMessage(update: {
    message: unknown;
    messageId?: string;
  }): { message: unknown; messageSeq?: number } | null {
    if (this.limit !== undefined || this.cursor !== undefined) {
      return null;
    }
    this.rawTranscriptSeq += 1;
    const nextMessage = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      seq: this.rawTranscriptSeq,
    });
    const projected = projectChatDisplayMessages([nextMessage], {
      maxChars: this.maxChars,
      emotionMode: this.getCurrentEmotionMode(),
    });
    if (projected.length === 0) {
      return null;
    }
    const [sanitizedMessage] = toSessionHistoryMessages(projected);
    if (!sanitizedMessage) {
      return null;
    }
    const nextMessages = [...this.sentHistory.messages, sanitizedMessage];
    this.sentHistory = buildPaginatedSessionHistory({
      messages: nextMessages,
      hasMore: false,
    });
    return {
      message: sanitizedMessage,
      messageSeq: resolveMessageSeq(sanitizedMessage),
    };
  }

  refresh(): PaginatedSessionHistory {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: this.readRawMessages(),
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
      emotionMode: this.getCurrentEmotionMode(),
    });
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.sentHistory = snapshot.history;
    return snapshot.history;
  }

  private readRawMessages(): unknown[] {
    return readSessionMessages(
      this.target.sessionId,
      this.target.storePath,
      this.target.sessionFile,
    );
  }
}
