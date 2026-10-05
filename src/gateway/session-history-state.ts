import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import type {
  PaginatedSessionHistory,
  SessionHistoryMessage,
  SessionHistoryReadParams,
  SessionHistorySnapshot,
  SessionHistoryTranscriptTarget,
} from "../config/sessions/session-history-types.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import {
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
  createCurrentUserProfileMessageProjector,
} from "./chat-display-projection.core.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./chat-display-projection.helpers.js";
import {
  createSubagentCoordinationHistoryProjection,
  prepareForwardedMessageCronJobNameResolver,
  projectForwardedMessages,
} from "./chat-display-projection.history.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import {
  createPreparedSessionHistorySubagentProjection,
  readSessionHistorySubagentLookup,
} from "./session-history-delta-visibility.js";
import {
  buildPaginatedSessionHistory,
  readSessionHistorySnapshotKernel,
} from "./session-history-snapshot.js";
import { readChatHistoryMessageSeq as resolveMessageSeq } from "./session-history-tail.js";
import {
  readTranscriptMessageIdempotencyKey,
  attachOpenClawTranscriptMeta,
} from "./session-transcript-entry-message.js";
import { resolveTranscriptPathForComparison } from "./session-transcript-path.js";
import type { SubagentCoordinationDisplayResolver } from "./session-transcript-read.types.js";
import * as sessionTranscriptReaders from "./session-transcript-readers.js";

type InlineSessionHistoryAppend = {
  message?: SessionHistoryMessage;
  messageSeq?: number;
  shouldRefresh?: boolean;
};

export async function readSessionHistorySnapshotAsync(
  params: SessionHistoryReadParams,
): Promise<SessionHistorySnapshot> {
  if (
    !params.target.storePath ||
    params.target.sessionEntry?.incognito ||
    isIncognitoSessionKey(params.target.sessionKey)
  ) {
    const snapshot = await readSessionHistorySnapshotKernel(params, {
      readers: sessionTranscriptReaders,
      resolveCurrentUserProfileDisplay,
      // Match the worker projection: install current names on the completed page below.
      resolveCronJobName: () => undefined,
    });
    const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
      snapshot.history.messages,
    );
    const messages = projectForwardedMessages(snapshot.history.messages, resolveCronJobName);
    return { ...snapshot, history: { ...snapshot.history, items: messages, messages } };
  }
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  const entry = params.target.sessionEntry;
  const snapshot = await readSessionHistoryPageInWorker({
    kind: "http",
    params: {
      ...params,
      target: {
        ...params.target,
        sessionEntry: entry
          ? {
              sessionId: entry.sessionId,
              updatedAt: entry.updatedAt,
              sessionStartedAt: entry.sessionStartedAt,
            }
          : undefined,
      },
    },
  });
  const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
    snapshot.history.messages,
  );
  const project = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  const messages = projectForwardedMessages(snapshot.history.messages, resolveCronJobName).map(
    project,
  );
  return { ...snapshot, history: { ...snapshot.history, items: messages, messages } };
}

/** Tracks session-history SSE state and decides when inline appends are still valid. */
export class SessionHistorySseState {
  private readonly target: SessionHistoryTranscriptTarget;
  private readonly maxChars: number;
  private readonly limit: number | undefined;
  private cursor: string | undefined;
  private sentHistory: PaginatedSessionHistory;
  private rawTranscriptSeq: number;
  private turnBoundaryPending: boolean;
  private assistantErrorPending: boolean;
  private transcriptPath: string | undefined;

  static fromSnapshot(
    params: SessionHistoryReadParams & { snapshot: SessionHistorySnapshot },
  ): SessionHistorySseState {
    return new SessionHistorySseState(params);
  }

  private constructor(params: SessionHistoryReadParams & { snapshot: SessionHistorySnapshot }) {
    this.target = params.target;
    this.maxChars = params.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
    this.limit = params.limit;
    const snapshot = params.snapshot;
    this.cursor = snapshot.history.windowReset ? undefined : params.cursor;
    this.sentHistory = snapshot.history;
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.turnBoundaryPending = snapshot.turnBoundaryPending;
    this.assistantErrorPending = snapshot.assistantErrorPending;
    this.transcriptPath = resolveTranscriptPathForComparison(snapshot.transcriptPath);
  }

  snapshot(): PaginatedSessionHistory {
    return this.sentHistory;
  }

  retainRecentMessages(maxMessages: number): PaginatedSessionHistory {
    if (this.sentHistory.messages.length <= maxMessages) {
      return this.snapshot();
    }

    const messages = this.sentHistory.messages.slice(-maxMessages);
    const firstSeq = resolveMessageSeq(messages[0]);
    this.sentHistory = buildPaginatedSessionHistory({
      messages,
      hasMore: true,
      ...(firstSeq !== undefined ? { nextCursor: String(firstSeq) } : {}),
    });
    return this.snapshot();
  }

  async prepareInlineMessage(update: {
    message: unknown;
    messageId?: string;
    messageSeq?: number;
  }): Promise<() => InlineSessionHistoryAppend | null> {
    if (this.limit !== undefined || this.cursor !== undefined) {
      return () => null;
    }
    const carriedSeq = asPositiveSafeInteger(update.messageSeq);
    if (carriedSeq !== undefined && carriedSeq <= this.rawTranscriptSeq) {
      return () => ({ shouldRefresh: true });
    }
    const messageSeq = carriedSeq ?? this.rawTranscriptSeq + 1;
    const idempotencyKey = readTranscriptMessageIdempotencyKey(update.message);
    const message = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      seq: messageSeq,
    });
    let subagentCoordination: SubagentCoordinationDisplayResolver | undefined;
    const lookup = readSessionHistorySubagentLookup(message);
    if (
      lookup &&
      this.target.storePath &&
      !this.target.sessionEntry?.incognito &&
      !isIncognitoSessionKey(this.target.sessionKey)
    ) {
      const { readSessionHistoryPageInWorker } =
        await import("../config/sessions/session-history-worker-runtime.js");
      const prepared = await readSessionHistoryPageInWorker({
        kind: "inline-visibility",
        params: { target: this.target, lookup },
      });
      subagentCoordination = createPreparedSessionHistorySubagentProjection(
        prepared.subagentCoordination,
        prepared.assertCurrent,
      );
    }
    const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver([
      ...this.sentHistory.messages,
      message,
    ]);
    // The stream queue retains ordering; its publisher reauthorizes before applying this transition.
    return () =>
      this.appendInlineMessage(message, messageSeq, subagentCoordination, resolveCronJobName);
  }

  private appendInlineMessage(
    message: unknown,
    messageSeq: number,
    subagentCoordination: SubagentCoordinationDisplayResolver | undefined,
    resolveCronJobName: (jobId: string) => string | undefined,
  ): InlineSessionHistoryAppend | null {
    subagentCoordination?.assertCurrent?.();
    const hadPendingTurnBoundary = this.turnBoundaryPending;
    const nextMessage = createSubagentCoordinationHistoryProjection(subagentCoordination)([
      message,
    ])[0];
    const nextProjection = projectChatDisplayMessagesWithState([nextMessage], {
      includeCommentaryFallbacks: true,
      maxChars: this.maxChars,
      turnBoundaryPending: hadPendingTurnBoundary,
      assistantErrorPending: this.assistantErrorPending,
      resolveCronJobName,
    });
    // Projection can split, drop, or rewrite raw transcript messages. When one
    // raw append changes multiple visible rows, callers must refresh instead of
    // emitting a misleading single SSE item.
    const projectedMessages = projectChatDisplayMessages(
      [...this.sentHistory.messages, nextMessage],
      {
        includeCommentaryFallbacks: true,
        maxChars: this.maxChars,
        resolveCurrentUserProfileDisplay,
        resolveCronJobName,
      },
    );
    subagentCoordination?.assertCurrent?.();
    this.rawTranscriptSeq = messageSeq;
    this.turnBoundaryPending = nextProjection.turnBoundaryPending;
    this.assistantErrorPending = nextProjection.assistantErrorPending;
    if (nextProjection.assistantErrorRecoveryObserved) {
      // Keep only the pending bit here: retaining raw transcript context would
      // undo the bounded SSE memory contract. The caller rereads canonical
      // history so full projection can remove the already-emitted placeholder.
      return { shouldRefresh: true };
    }
    const projectedPrefix = projectedMessages.slice(0, this.sentHistory.messages.length);
    // A rewritten prefix needs a full refresh; only an unchanged prefix can append inline.
    if (
      projectedMessages.length > this.sentHistory.messages.length &&
      isDeepStrictEqual(projectedPrefix, this.sentHistory.messages)
    ) {
      const addedMessages = projectedMessages.slice(this.sentHistory.messages.length);
      if (hadPendingTurnBoundary && !this.turnBoundaryPending) {
        const firstAdded = attachOpenClawTranscriptMeta(addedMessages[0], {
          turnBoundary: true,
        }) as SessionHistoryMessage;
        addedMessages[0] = firstAdded;
        projectedMessages[this.sentHistory.messages.length] = firstAdded;
      }
      if (addedMessages.length === 1) {
        const projectedMessage = expectDefined(addedMessages[0], "projected inline message");
        const emittedMessage: SessionHistoryMessage =
          resolveMessageSeq(projectedMessage) === undefined
            ? (attachOpenClawTranscriptMeta(projectedMessage, {
                seq: this.rawTranscriptSeq,
              }) as SessionHistoryMessage)
            : projectedMessage;
        this.sentHistory = buildPaginatedSessionHistory({
          messages: [...this.sentHistory.messages, emittedMessage],
          hasMore: false,
        });
        return { message: emittedMessage, messageSeq: resolveMessageSeq(emittedMessage) };
      }
    }
    if (
      nextProjection.messages.length === 0 &&
      isDeepStrictEqual(projectedMessages, this.sentHistory.messages)
    ) {
      return null;
    }
    this.sentHistory = buildPaginatedSessionHistory({
      messages: projectedMessages,
      hasMore: false,
    });
    return { shouldRefresh: true };
  }

  shouldRefreshForTranscriptPath(updatePath: string | undefined): boolean {
    const nextPath = resolveTranscriptPathForComparison(updatePath);
    return Boolean(this.transcriptPath && nextPath && this.transcriptPath !== nextPath);
  }

  async refreshAsync(): Promise<PaginatedSessionHistory> {
    const snapshot = await readSessionHistorySnapshotAsync({
      target: this.target,
      maxChars: this.maxChars,
      limit: this.limit,
      cursor: this.cursor,
    });
    if (snapshot.history.windowReset) {
      this.cursor = undefined;
    }
    this.rawTranscriptSeq = snapshot.rawTranscriptSeq;
    this.turnBoundaryPending = snapshot.turnBoundaryPending;
    this.assistantErrorPending = snapshot.assistantErrorPending;
    this.transcriptPath = resolveTranscriptPathForComparison(snapshot.transcriptPath);
    this.sentHistory = snapshot.history;
    return snapshot.history;
  }
}
