import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  readRecentSessionTranscriptHistoryEventsFromProjection,
  readSessionTranscriptHistoryEventByIdFromProjection,
  readSessionTranscriptHistoryEventLookupFromProjection,
  readSessionTranscriptHistoryEventPageFromProjection,
  readSessionTranscriptHistoryEventsFromProjection,
  readSessionTranscriptHistoryAnchorPageFromProjection,
  type SessionTranscriptMessageByIdOptions,
} from "../config/sessions/session-accessor.sqlite-history-query.js";
import type {
  CurrentTranscriptProjection,
  SessionTranscriptMessageEvent,
} from "../config/sessions/session-accessor.sqlite-projection-read.js";
import type {
  TranscriptRecentReadLimits,
  TranscriptAnchorPageOptions,
} from "../sessions/transcript-anchor-page.js";
import type {
  TranscriptReadWindow,
  TranscriptReadWindowOptions,
} from "../sessions/transcript-read-window.js";
import type { SubagentCoordinationDisplayResolver } from "./chat-display-projection.history.js";
import {
  ArchivedTranscriptReader,
  type ReadRecentSessionMessagesOptions,
  type ReadSessionMessagesAsyncOptions,
} from "./session-transcript-archive-reader.js";
import { projectTranscriptEntryMessage } from "./session-transcript-entry-message.js";
import type { ResolvedTranscriptReadTarget } from "./session-transcript-read-target.js";

export type { SessionTranscriptReadScope };
export type SessionTranscriptReadAccess = {
  resolveTarget: (scope: SessionTranscriptReadScope) => Promise<ResolvedTranscriptReadTarget>;
  readSnapshot: <T>(
    target: ResolvedTranscriptReadTarget,
    read: (projection: CurrentTranscriptProjection) => T,
    options?: { readOnly?: boolean },
  ) => Promise<T>;
};

export type ReadRecentSessionMessagesResult = {
  olderOffset?: number;
  omittedOversized?: boolean;
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  readWindow?: TranscriptReadWindow;
  messages: unknown[];
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "active" | "reset-archive";
  totalMessages: number;
};

type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

type ReadSessionMessageByIdResult = {
  message?: unknown;
  seq?: number;
  oversized: boolean;
  found: boolean;
  serializedBytes?: number;
};

function archivedTranscriptReader(target: ResolvedTranscriptReadTarget): ArchivedTranscriptReader {
  return new ArchivedTranscriptReader({
    agentId: target.agentId,
    sessionId: target.sessionId,
    storePath: target.storePath,
  });
}

function projectSqliteHistoryEvents(entries: readonly SessionTranscriptMessageEvent[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    const message = projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function normalizeRecentSqliteReadOptions(
  opts?: Partial<ReadRecentSessionMessagesOptions> &
    TranscriptReadWindowOptions & { readOnly?: boolean },
) {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  const maxBytes =
    typeof opts?.maxBytes === "number" && Number.isFinite(opts.maxBytes)
      ? Math.max(1024, Math.floor(opts.maxBytes))
      : 8 * 1024 * 1024;
  const defaultMaxLines = maxMessages * 20 + 20;
  const maxLines =
    typeof opts?.maxLines === "number" && Number.isFinite(opts.maxLines)
      ? Math.max(maxMessages, Math.floor(opts.maxLines))
      : defaultMaxLines;
  return {
    maxMessages,
    maxBytes,
    maxLines,
    captureReadWindow: opts?.captureReadWindow,
    expectedReadWindow: opts?.expectedReadWindow,
    readOnly: opts?.readOnly,
  };
}

function readRecentSqliteMessageRecords(
  projection: CurrentTranscriptProjection,
  opts?: Partial<ReadRecentSessionMessagesOptions> &
    TranscriptReadWindowOptions & { readOnly?: boolean },
): {
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  readWindow?: TranscriptReadWindow;
  messages: unknown[];
  totalMessages: number;
} {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const page = readRecentSessionTranscriptHistoryEventsFromProjection(projection, normalized);
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    ...(page.deltaCursor ? { deltaCursor: page.deltaCursor } : {}),
    displaySource: page.displaySource,
    ...(page.readWindow ? { readWindow: page.readWindow } : {}),
    messages: projectSqliteHistoryEvents(page.events),
    totalMessages: page.totalMessages,
  };
}

type ReadSessionMessagesAroundIdResult = ReadRecentSessionMessagesResult & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

/** Share pagination and archive policy while the caller owns acquisition and restoration. */
export function createSessionTranscriptReader(access: SessionTranscriptReadAccess) {
  /** Reads display messages asynchronously through the reader seam. */
  async function readSessionMessagesAsync(
    scope: SessionTranscriptReadScope,
    opts: ReadSessionMessagesAsyncOptions & { readOnly?: boolean },
  ): Promise<unknown[]> {
    return (await readSessionMessagesWithSourceAsync(scope, opts)).messages;
  }

  /** Reads display messages with source metadata through the reader seam. */
  async function readSessionMessagesWithSourceAsync(
    scope: SessionTranscriptReadScope,
    opts: ReadSessionMessagesAsyncOptions & { readOnly?: boolean },
  ): Promise<ReadSessionMessagesResult> {
    const target = await access.resolveTarget(scope);
    const messages = await access.readSnapshot(
      target,
      (projection) =>
        opts.mode === "recent"
          ? readRecentSqliteMessageRecords(projection, opts).messages
          : projectSqliteHistoryEvents(
              readSessionTranscriptHistoryEventsFromProjection(projection),
            ),
      opts,
    );
    if (messages.length === 0 && opts.allowResetArchiveFallback === true) {
      return await archivedTranscriptReader(target).read({ ...opts, resetArchiveOnly: true });
    }
    return {
      messages,
      transcriptPath: target.sessionFile,
    };
  }

  /** Finds one display message by transcript id through the reader seam. */
  async function readSessionMessageByIdAsync(
    scope: SessionTranscriptReadScope,
    messageId: string,
    opts?: SessionTranscriptMessageByIdOptions & { allowResetArchiveFallback?: boolean },
  ): Promise<ReadSessionMessageByIdResult> {
    const target = await access.resolveTarget(scope);
    const foundEvent = await access.readSnapshot(target, (projection) =>
      readSessionTranscriptHistoryEventByIdFromProjection(projection, messageId, opts),
    );
    if (foundEvent) {
      return {
        found: true,
        message: projectTranscriptEntryMessage(
          foundEvent.event,
          foundEvent.seq,
          foundEvent.displayPosition,
        ),
        oversized: false,
        seq: foundEvent.seq,
        ...(foundEvent.serializedBytes !== undefined
          ? { serializedBytes: foundEvent.serializedBytes }
          : {}),
      };
    }
    if (opts?.allowResetArchiveFallback === true && !opts.currentOnly) {
      return await archivedTranscriptReader(target).readById(messageId, {
        ...opts,
        resetArchiveOnly: true,
      });
    }
    return { found: false, oversized: false };
  }

  /** Read exact membership while retaining full-history validity and empty-only archive fallback. */
  async function readSessionMessagesMatchingIdAsync(
    scope: SessionTranscriptReadScope,
    messageId: string,
  ): Promise<unknown[]> {
    const target = await access.resolveTarget(scope);
    const lookup = await access.readSnapshot(target, (projection) =>
      readSessionTranscriptHistoryEventLookupFromProjection(projection, messageId),
    );
    const messages = lookup.hasDisplayMessages
      ? projectSqliteHistoryEvents(lookup.events)
      : await archivedTranscriptReader(target).readMessageCandidatesById(messageId, {
          allowResetArchiveFallback: true,
          resetArchiveOnly: true,
        });
    return messages.filter(
      (message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id === messageId,
    );
  }

  /** Reads recent messages with total-count metadata asynchronously through the reader seam. */
  async function readRecentSessionMessagesWithStatsAsync(
    scope: SessionTranscriptReadScope,
    opts: ReadRecentSessionMessagesOptions & TranscriptReadWindowOptions & { readOnly?: boolean },
  ): Promise<ReadRecentSessionMessagesResult> {
    const target = await access.resolveTarget(scope);
    const { activeLeafEntryId, deltaCursor, displaySource, readWindow, messages, totalMessages } =
      await access.readSnapshot(
        target,
        (projection) => readRecentSqliteMessageRecords(projection, opts),
        opts,
      );
    if (totalMessages === 0 && messages.length === 0 && opts.allowResetArchiveFallback === true) {
      return await archivedTranscriptReader(target).readRecentWithStats({
        ...opts,
        resetArchiveOnly: true,
      });
    }
    return {
      ...(activeLeafEntryId !== undefined ? { activeLeafEntryId } : {}),
      ...(deltaCursor ? { deltaCursor } : {}),
      displaySource,
      ...(readWindow ? { readWindow } : {}),
      messages,
      totalMessages,
      transcriptPath: target.sessionFile,
      transcriptSource: "active",
    };
  }

  /** Reads one offset page with total-count metadata through the reader seam. */
  async function readSessionMessagesPageWithStatsAsync(
    scope: SessionTranscriptReadScope,
    opts: TranscriptReadWindowOptions & {
      offset: number;
      maxMessages: number;
      beforeSeq?: number;
      recentAtHead?: TranscriptRecentReadLimits;
      maxBytes?: number;
      allowResetArchiveFallback?: boolean;
      readOnly?: boolean;
    },
  ): Promise<ReadRecentSessionMessagesResult> {
    const target = await access.resolveTarget(scope);
    const page = await access.readSnapshot(
      target,
      (projection) => readSessionTranscriptHistoryEventPageFromProjection(projection, opts),
      opts,
    );
    if (page.totalMessages === 0 && opts.allowResetArchiveFallback === true) {
      return await archivedTranscriptReader(target).readPage({ ...opts, resetArchiveOnly: true });
    }
    return {
      ...(Object.hasOwn(page, "activeLeafEntryId")
        ? { activeLeafEntryId: page.activeLeafEntryId }
        : {}),
      ...(page.olderOffset !== undefined ? { olderOffset: page.olderOffset } : {}),
      ...(page.deltaCursor ? { deltaCursor: page.deltaCursor } : {}),
      ...(page.omittedOversized ? { omittedOversized: true } : {}),
      messages: projectSqliteHistoryEvents(page.events),
      displaySource: page.displaySource,
      ...(page.readWindow ? { readWindow: page.readWindow } : {}),
      totalMessages: page.totalMessages,
      transcriptPath: target.sessionFile,
      transcriptSource: "active",
    };
  }
  /** Reads one message-id-anchored page from a single transcript snapshot. */
  async function readSessionMessagesAroundIdWithStatsAsync(
    scope: SessionTranscriptReadScope,
    opts: TranscriptAnchorPageOptions & { allowResetArchiveFallback?: boolean; readOnly?: boolean },
  ): Promise<ReadSessionMessagesAroundIdResult> {
    const target = await access.resolveTarget(scope);
    const sessionFile =
      !scope.sessionFile &&
      scope.sessionEntry?.sessionId &&
      scope.sessionEntry.sessionId !== scope.sessionId
        ? undefined
        : target.sessionFile;
    const page = await access.readSnapshot(
      target,
      (projection) => readSessionTranscriptHistoryAnchorPageFromProjection(projection, opts),
      opts,
    );
    if (!page.found) {
      if (opts.allowResetArchiveFallback === true) {
        return await new ArchivedTranscriptReader({
          agentId: target.agentId,
          sessionFile,
          sessionId: target.sessionId,
          storePath: target.storePath,
        }).readAroundId({ ...opts, resetArchiveOnly: true });
      }
      return {
        found: false,
        hasOverreadContext: false,
        messages: [],
        offset: 0,
        totalMessages: page.totalMessages,
        transcriptPath: target.sessionFile,
      };
    }
    return {
      found: true,
      displaySource: page.displaySource,
      hasOverreadContext: page.hasOverreadContext,
      messages: page.events.flatMap((entry) => {
        const message = projectTranscriptEntryMessage(
          entry.event,
          entry.seq,
          entry.displayPosition,
        );
        return message === undefined ? [] : [message];
      }),
      offset: page.offset,
      totalMessages: page.totalMessages,
      transcriptPath: target.sessionFile,
    };
  }

  return {
    readSessionMessagesAsync,
    readSessionMessagesWithSourceAsync,
    readSessionMessageByIdAsync,
    readSessionMessagesMatchingIdAsync,
    readRecentSessionMessagesWithStatsAsync,
    readSessionMessagesPageWithStatsAsync,
    readSessionMessagesAroundIdWithStatsAsync,
  };
}
export type SessionTranscriptReader = ReturnType<typeof createSessionTranscriptReader> & {
  subagentCoordination?: SubagentCoordinationDisplayResolver;
};
