import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  projectChatDisplayMessages,
} from "./chat-display-projection.js";
import {
  attachOpenClawTranscriptMeta,
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesAsync,
} from "./session-utils.js";

type SessionHistoryTranscriptMeta = {
  seq?: number;
};

type SessionHistoryMessage = Record<string, unknown> & {
  __openclaw?: SessionHistoryTranscriptMeta;
};

type PaginatedSessionHistory = {
  items: SessionHistoryMessage[];
  messages: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore: boolean;
};

type SessionHistorySnapshot = {
  history: PaginatedSessionHistory;
  rawTranscriptSeq: number;
};

type InlineSessionHistoryAppend = {
  message?: unknown;
  messageSeq?: number;
  shouldRefresh?: boolean;
};

type SessionHistoryTranscriptTarget = {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
};

type SessionHistoryRawSnapshot = {
  rawMessages: unknown[];
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
};

/** Expands a visible history limit into the raw tail window needed before projection filters. */
export function resolveSessionHistoryTailReadOptions(limit: number): {
  maxMessages: number;
  maxLines: number;
} {
  const requested = Math.max(1, Math.floor(limit));
  const rawWindow = requested * 20 + 20;
  return {
    maxMessages: rawWindow,
    maxLines: rawWindow,
  };
}

function resolveCursorSeq(cursor: string | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }
  const normalized = cursor.startsWith("seq:") ? cursor.slice(4) : cursor;
  // Cursor values are exact transcript sequence numbers; reject partial parses
  // so "seq:2next" cannot accidentally page from message 2.
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

function resolveMessageSeq(message: SessionHistoryMessage | undefined): number | undefined {
  return asPositiveSafeInteger(message?.["__openclaw"]?.seq);
}

function isMessageToolMirrorMessage(message: SessionHistoryMessage): boolean {
  return message.openclawMessageToolMirror !== undefined;
}

function paginateSessionMessages(
  messages: SessionHistoryMessage[],
  limit: number | undefined,
  cursor: string | undefined,
): PaginatedSessionHistory {
  const cursorSeq = resolveCursorSeq(cursor);
  let endExclusive = messages.length;
  if (typeof cursorSeq === "number") {
    // Page backward from the first message at or after the cursor sequence.
    // Messages without OpenClaw seq metadata fall back to their 1-based index.
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

/** Builds one paginated, display-safe history page while preserving raw transcript progress. */
export function buildSessionHistorySnapshot(params: {
  rawMessages: unknown[];
  maxChars?: number;
  limit?: number;
  cursor?: string;
  rawTranscriptSeq?: number;
  totalRawMessages?: number;
}): SessionHistorySnapshot {
  const visibleMessages = toSessionHistoryMessages(
    projectChatDisplayMessages(params.rawMessages, {
      maxChars: params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    }),
  );
  const history = paginateSessionMessages(visibleMessages, params.limit, params.cursor);
  if (
    !params.cursor &&
    typeof params.totalRawMessages === "number" &&
    params.totalRawMessages > params.rawMessages.length &&
    history.messages.length > 0
  ) {
    // Recent-tail reads may omit older raw messages before projection. Mark the
    // display page as partial even when every loaded visible message was used.
    const firstSeq = resolveMessageSeq(history.messages[0]);
    history.hasMore = true;
    if (typeof firstSeq === "number") {
      history.nextCursor = String(firstSeq);
    }
  }
  const rawHistoryMessages = toSessionHistoryMessages(params.rawMessages);
  return {
    history,
    rawTranscriptSeq:
      params.rawTranscriptSeq ??
      resolveMessageSeq(rawHistoryMessages.at(-1)) ??
      rawHistoryMessages.length,
  };
}

/** Maintains chat.history SSE pagination state between full refreshes and inline appends. */
export class SessionHistorySseState {
  private readonly target: SessionHistoryTranscriptTarget;
  private readonly maxChars: number;
  private readonly limit: number | undefined;
  private readonly cursor: string | undefined;
  private sentHistory: PaginatedSessionHistory;
  private rawTranscriptSeq: number;

  /** Seeds SSE state from the same raw messages used for the initial history response. */
  static fromRawSnapshot(params: {
    target: SessionHistoryTranscriptTarget;
    rawMessages: unknown[];
    rawTranscriptSeq?: number;
    totalRawMessages?: number;
    maxChars?: number;
    limit?: number;
    cursor?: string;
  }): SessionHistorySseState {
    return new SessionHistorySseState({
      target: params.target,
      maxChars: params.maxChars,
      limit: params.limit,
      cursor: params.cursor,
      initialRawMessages: params.rawMessages,
      rawTranscriptSeq: params.rawTranscriptSeq,
      totalRawMessages: params.totalRawMessages,
    });
  }

  private constructor(params: {
    target: SessionHistoryTranscriptTarget;
    maxChars?: number;
    limit?: number;
    cursor?: string;
    initialRawMessages: unknown[];
    rawTranscriptSeq?: number;
    totalRawMessages?: number;
  }) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    this.cursor = params.cursor;
    const snapshot = this.buildSnapshot({
      rawMessages: params.initialRawMessages,
      ...(typeof params.rawTranscriptSeq === "number"
        ? { rawTranscriptSeq: params.rawTranscriptSeq }
        : {}),
      ...(typeof params.totalRawMessages === "number"
        ? { totalRawMessages: params.totalRawMessages }
        : {}),
    });
    this.sentHistory = snapshot.history;
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
  }

  /** Returns the last display page sent to the SSE client. */
  snapshot(): PaginatedSessionHistory {
    return this.sentHistory;
  }

  /** Attempts to project one live transcript append, or asks the caller to refresh. */
  appendInlineMessage(update: {
    message: unknown;
    messageId?: string;
    messageSeq?: number;
  }): InlineSessionHistoryAppend | null {
    if (this.limit !== undefined || this.cursor !== undefined) {
      return null;
    }
    const carriedSeq = asPositiveSafeInteger(update.messageSeq);
    if (carriedSeq !== undefined) {
      // Duplicate or out-of-order live appends mean the SSE client has missed a
      // state transition; force a disk refresh instead of appending stale data.
      if (carriedSeq <= this.rawTranscriptSeq) {
        return { shouldRefresh: true };
      }
      this.rawTranscriptSeq = carriedSeq;
    } else {
      this.rawTranscriptSeq += 1;
    }
    const nextMessage = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      seq: this.rawTranscriptSeq,
    });
    const projectedMessages = toSessionHistoryMessages(
      projectChatDisplayMessages([...this.sentHistory.messages, nextMessage], {
        maxChars: this.maxChars,
      }),
    );
    if (projectedMessages.length > this.sentHistory.messages.length) {
      const addedMessages = projectedMessages.slice(this.sentHistory.messages.length);
      if (addedMessages.length > 1) {
        this.sentHistory = buildPaginatedSessionHistory({
          messages: projectedMessages,
          hasMore: false,
        });
        return { shouldRefresh: true };
      }
      const projectedMessage = addedMessages[0];
      if (projectedMessage !== undefined) {
        // message-tool mirrors can be synthesized from a later silent control
        // reply, so attach the current raw seq when projection did not carry one.
        const emittedMessage: SessionHistoryMessage =
          isMessageToolMirrorMessage(projectedMessage) ||
          resolveMessageSeq(projectedMessage) === undefined
            ? (attachOpenClawTranscriptMeta(projectedMessage, {
                seq: this.rawTranscriptSeq,
              }) as SessionHistoryMessage)
            : projectedMessage;
        const nextMessages = [...this.sentHistory.messages, emittedMessage];
        this.sentHistory = buildPaginatedSessionHistory({
          messages: nextMessages,
          hasMore: false,
        });
        return {
          message: emittedMessage,
          messageSeq: resolveMessageSeq(emittedMessage),
        };
      }
    }
    const [sanitizedMessage] = toSessionHistoryMessages(
      projectChatDisplayMessages([nextMessage], { maxChars: this.maxChars }),
    );
    if (!sanitizedMessage) {
      if (projectedMessages.length < this.sentHistory.messages.length) {
        // A hidden control message can collapse previously buffered projection
        // state; ask the client to reload the current display page.
        this.sentHistory = buildPaginatedSessionHistory({
          messages: projectedMessages,
          hasMore: false,
        });
        return { shouldRefresh: true };
      }
      return null;
    }
    if (projectedMessages.length <= this.sentHistory.messages.length) {
      this.sentHistory = buildPaginatedSessionHistory({
        messages: projectedMessages,
        hasMore: false,
      });
      return { shouldRefresh: true };
    }
    const projectedMessage = projectedMessages.at(-1) ?? sanitizedMessage;
    const nextMessages = [...this.sentHistory.messages, projectedMessage];
    this.sentHistory = buildPaginatedSessionHistory({
      messages: nextMessages,
      hasMore: false,
    });
    return {
      message: projectedMessage,
      messageSeq: resolveMessageSeq(projectedMessage),
    };
  }

  /** Reloads transcript history from disk and replaces the tracked display page. */
  async refreshAsync(): Promise<PaginatedSessionHistory> {
    const rawSnapshot = await this.readRawSnapshotAsync();
    const snapshot = this.buildSnapshot(rawSnapshot);
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.sentHistory = snapshot.history;
    return snapshot.history;
  }

  private buildSnapshot(rawSnapshot: SessionHistoryRawSnapshot): SessionHistorySnapshot {
    return buildSessionHistorySnapshot({
      rawMessages: rawSnapshot.rawMessages,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
      ...(typeof rawSnapshot.rawTranscriptSeq === "number"
        ? { rawTranscriptSeq: rawSnapshot.rawTranscriptSeq }
        : {}),
      ...(typeof rawSnapshot.totalRawMessages === "number"
        ? { totalRawMessages: rawSnapshot.totalRawMessages }
        : {}),
    });
  }

  private async readRawSnapshotAsync(): Promise<SessionHistoryRawSnapshot> {
    if (this.cursor === undefined && typeof this.limit === "number") {
      // Non-cursor history streams only need a raw tail wide enough for display
      // projection filters; cursor mode below needs the full transcript.
      const snapshot = await readRecentSessionMessagesWithStatsAsync(
        this.target.sessionId,
        this.target.storePath,
        this.target.sessionFile,
        {
          ...resolveSessionHistoryTailReadOptions(this.limit),
        },
      );
      return {
        rawMessages: snapshot.messages,
        rawTranscriptSeq: snapshot.totalMessages,
        totalRawMessages: snapshot.totalMessages,
      };
    }
    return {
      rawMessages: await readSessionMessagesAsync(
        this.target.sessionId,
        this.target.storePath,
        this.target.sessionFile,
        {
          mode: "full",
          reason: "session history cursor pagination",
        },
      ),
    };
  }
}
