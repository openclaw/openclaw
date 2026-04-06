import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  sanitizeChatHistoryMessages,
} from "./server-methods/chat.js";
import { attachOpenClawTranscriptMeta, readSessionMessages } from "./session-utils.js";

export type PaginatedSessionHistory = {
  items: unknown[];
  messages: unknown[];
  nextCursor?: string;
  hasMore: boolean;
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

export function resolveMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const seq = (meta as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : undefined;
}

export function paginateSessionMessages(
  messages: unknown[],
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
  const items = messages.slice(start, endExclusive);
  const firstSeq = resolveMessageSeq(items[0]);
  return {
    items,
    messages: items,
    hasMore: start > 0,
    ...(start > 0 && typeof firstSeq === "number" ? { nextCursor: String(firstSeq) } : {}),
  };
}

function sanitizeRawTranscriptMessages(params: {
  rawMessages: unknown[];
  maxChars?: number;
  limit?: number;
  cursor?: string;
}): PaginatedSessionHistory {
  return paginateSessionMessages(
    sanitizeChatHistoryMessages(
      params.rawMessages,
      params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    ),
    params.limit,
    params.cursor,
  );
}

export class SessionHistorySseState {
  private readonly target: SessionHistoryTranscriptTarget;
  private readonly maxChars: number;
  private readonly limit: number | undefined;
  private readonly cursor: string | undefined;
  private sentHistory: PaginatedSessionHistory;
  private rawTranscriptSeq: number;

  constructor(params: {
    target: SessionHistoryTranscriptTarget;
    maxChars?: number;
    limit?: number;
    cursor?: string;
    initialRawMessages?: unknown[];
  }) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    this.cursor = params.cursor;
    const rawMessages = params.initialRawMessages ?? this.readRawMessages();
    this.sentHistory = sanitizeRawTranscriptMessages({
      rawMessages,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
    });
    this.rawTranscriptSeq = resolveMessageSeq(rawMessages.at(-1)) ?? rawMessages.length;
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
    const sanitized = sanitizeChatHistoryMessages([nextMessage], this.maxChars);
    if (sanitized.length === 0) {
      return null;
    }
    const sanitizedMessage = sanitized[0];
    this.sentHistory = {
      items: [...this.sentHistory.items, sanitizedMessage],
      messages: [...this.sentHistory.items, sanitizedMessage],
      hasMore: false,
    };
    return {
      message: sanitizedMessage,
      messageSeq: resolveMessageSeq(sanitizedMessage),
    };
  }

  refresh(): PaginatedSessionHistory {
    const rawMessages = this.readRawMessages();
    this.rawTranscriptSeq = resolveMessageSeq(rawMessages.at(-1)) ?? rawMessages.length;
    this.sentHistory = sanitizeRawTranscriptMessages({
      rawMessages,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
    });
    return this.sentHistory;
  }

  private readRawMessages(): unknown[] {
    return readSessionMessages(
      this.target.sessionId,
      this.target.storePath,
      this.target.sessionFile,
    );
  }
}
