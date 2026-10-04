import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveVisibleHistoryEventCount } from "../config/sessions/session-accessor.sqlite-history-projection.js";
import {
  readTranscriptDisplayDeltaFromProjection,
  readRecentSessionTranscriptHistoryEventsFromProjection,
  readOffPathSessionTranscriptEventsFromProjection,
  readSessionTranscriptHistoryEventByIdFromProjection,
  readSessionTranscriptHistoryEventLookupFromProjection,
  readSessionTranscriptHistoryEventPageFromProjection,
  readSessionTranscriptHistoryEventsFromProjection,
  readSessionTranscriptHistoryAnchorPageFromProjection,
} from "../config/sessions/session-accessor.sqlite-history-query.js";
import type {
  CurrentTranscriptProjection,
  SessionTranscriptMessageEvent,
} from "../config/sessions/session-accessor.sqlite-projection-read.js";
import {
  iterateVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "../config/sessions/session-accessor.sqlite-reset-window.js";
import { SessionTranscriptStorageUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import type { TranscriptAnchorPageOptions } from "../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindowOptions } from "../sessions/transcript-read-window.js";
import {
  createChatHistoryRecoveryProjection,
  isPendingAssistantError,
} from "./chat-display-projection.core.js";
import {
  dropPreSessionStartAnnouncePairs,
  isPreSessionStartAssistantMessage,
} from "./chat-display-projection.history.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import {
  readChatHistoryMessageId,
  readChatHistoryRecoveryContext,
} from "./session-history-tail.js";
import { ArchivedTranscriptReader } from "./session-transcript-archive-reader.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";
import type { ResolvedTranscriptReadTarget } from "./session-transcript-read-target.js";
import type {
  ReadRecentSessionMessagesOptions,
  ReadRecentSessionMessagesResult,
  ReadSessionMessageByIdResult,
  ReadSessionMessagesAroundIdResult,
  ReadSessionMessagesAsyncOptions,
  ReadSessionMessagesResult,
  SessionTranscriptMessageByIdOptions,
  SessionTranscriptPageOptions,
  SessionTranscriptProjectionSelection,
  SessionTranscriptProjectionSelectionResults,
  SessionTranscriptReadOptions,
  SessionTranscriptReadScope,
  SessionTranscriptReader,
  SessionTranscriptPageReader,
  SessionTranscriptVisitor,
  SubagentCoordinationDisplayResolver,
} from "./session-transcript-read.types.js";
import {
  prepareSessionTranscriptSummaryReader,
  type SessionTranscriptSummaryQuery,
} from "./session-transcript-summary.js";

export type SessionTranscriptReadAccess = {
  subagentCoordination?: SubagentCoordinationDisplayResolver;
  resolveTarget: (scope: SessionTranscriptReadScope) => Promise<ResolvedTranscriptReadTarget>;
  readSnapshot: <T>(
    target: ResolvedTranscriptReadTarget,
    read: (projection: CurrentTranscriptProjection) => T,
    options?: { readOnly?: boolean },
  ) => Promise<T>;
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
    const message = sqliteMessageEventWithSeq(entry);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function capAnchorEventsByBytes(
  events: SessionTranscriptMessageEvent[],
  maxBytes: number | undefined,
): SessionTranscriptMessageEvent[] {
  if (maxBytes === undefined) {
    return events;
  }
  const limit = Math.max(1_024, Math.floor(maxBytes));
  let bytes = 2;
  let start = events.length;
  while (start > 0) {
    const eventBytes = jsonUtf8Bytes(events[start - 1]);
    const separatorBytes = start === events.length ? 0 : 1;
    if (bytes + separatorBytes + eventBytes > limit) {
      break;
    }
    bytes += separatorBytes + eventBytes;
    start -= 1;
  }
  return events.slice(start);
}

function readRecentSqliteMessageRecords(
  projection: CurrentTranscriptProjection,
  opts?: Partial<ReadRecentSessionMessagesOptions> & TranscriptReadWindowOptions,
): ReadRecentSessionMessagesResult {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  const page = readRecentSessionTranscriptHistoryEventsFromProjection(projection, {
    maxMessages,
    maxBytes: resolveIntegerOption(opts?.maxBytes, 8 * 1024 * 1024, { min: 1024 }),
    maxLines: resolveIntegerOption(opts?.maxLines, maxMessages * 20 + 20, { min: maxMessages }),
    captureReadWindow: opts?.captureReadWindow,
    expectedReadWindow: opts?.expectedReadWindow,
  });
  return {
    ...(page.activeLeafEntryId !== undefined ? { activeLeafEntryId: page.activeLeafEntryId } : {}),
    ...(page.deltaCursor ? { deltaCursor: page.deltaCursor } : {}),
    displaySource: page.displaySource,
    ...(page.readWindow ? { readWindow: page.readWindow } : {}),
    ...(page.windowReset ? { windowReset: true } : {}),
    messages: projectSqliteHistoryEvents(page.events),
    totalMessages: page.totalMessages,
  };
}

function filterSessionMessagesMatchingId(messages: unknown[], messageId: string): unknown[] {
  return messages.filter(
    (message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id === messageId,
  );
}

/** Select and format one admitted projection; acquisition and archive fallback stay outside. */
export function selectSessionTranscriptProjection<
  Selection extends SessionTranscriptProjectionSelection,
>(
  projection: CurrentTranscriptProjection,
  selection: Selection,
  sessionFile?: string,
): SessionTranscriptProjectionSelectionResults[Selection["kind"]];
export function selectSessionTranscriptProjection(
  projection: CurrentTranscriptProjection,
  selection: SessionTranscriptProjectionSelection,
  sessionFile?: string,
): SessionTranscriptProjectionSelectionResults[SessionTranscriptProjectionSelection["kind"]] {
  switch (selection.kind) {
    case "delta":
      return readTranscriptDisplayDeltaFromProjection(projection, selection.options);
    case "count":
      return resolveVisibleHistoryEventCount(projection);
    case "recent":
      return {
        ...readRecentSqliteMessageRecords(projection, selection.options),
        transcriptPath: sessionFile,
        transcriptSource: "active",
      };
    case "page": {
      const page = readSessionTranscriptHistoryEventPageFromProjection(
        projection,
        selection.options,
      );
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
        ...(page.windowReset ? { windowReset: true } : {}),
        totalMessages: page.totalMessages,
        transcriptPath: sessionFile,
        transcriptSource: "active",
      };
    }
    case "around-id": {
      const page = readSessionTranscriptHistoryAnchorPageFromProjection(
        projection,
        selection.options,
      );
      if (!page.found) {
        return {
          found: false,
          hasOverreadContext: false,
          messages: [],
          offset: 0,
          totalMessages: page.totalMessages,
          transcriptPath: sessionFile,
        };
      }
      return {
        found: true,
        ...(page.windowReset ? { windowReset: true } : {}),
        ...(page.readWindow ? { readWindow: page.readWindow } : {}),
        displaySource: page.displaySource,
        hasOverreadContext: page.hasOverreadContext,
        messages: capAnchorEventsByBytes(page.events, selection.options.maxBytes)
          .map(sqliteMessageEventWithSeq)
          .filter((message) => message !== undefined),
        offset: page.offset,
        totalMessages: page.totalMessages,
        transcriptPath: sessionFile,
      };
    }
    case "by-id": {
      const event = readSessionTranscriptHistoryEventByIdFromProjection(
        projection,
        selection.messageId,
        selection.options,
        selection.options?.historyVisibility
          ? (candidate) =>
              isPreSessionStartAssistantMessage(
                sqliteMessageEventWithSeq(candidate),
                selection.options?.historyVisibility?.sessionStartedAt,
              )
          : undefined,
      );
      return event
        ? {
            found: true,
            message: sqliteMessageEventWithSeq(event),
            ...(selection.options?.historyVisibility
              ? {
                  historyContext: {
                    displaySource: event.displayPosition?.source,
                    ...(event.preceding
                      ? { precedingMessage: sqliteMessageEventWithSeq(event.preceding) }
                      : {}),
                  },
                }
              : {}),
            oversized: false,
            seq: event.seq,
            ...(event.serializedBytes !== undefined
              ? { serializedBytes: event.serializedBytes }
              : {}),
          }
        : { found: false, oversized: false };
    }
    case "source": {
      const opts = selection.options;
      return {
        messages:
          opts.mode === "recent"
            ? readRecentSqliteMessageRecords(projection, opts).messages
            : projectSqliteHistoryEvents(
                readSessionTranscriptHistoryEventsFromProjection(projection),
              ),
        transcriptPath: sessionFile,
        ...(opts.mode === "full" && opts.includeOffPathMessages
          ? {
              offPathMessages: projectSqliteHistoryEvents(
                readOffPathSessionTranscriptEventsFromProjection(projection),
              ),
            }
          : {}),
      };
    }
    case "lookup": {
      const lookup = readSessionTranscriptHistoryEventLookupFromProjection(
        projection,
        selection.messageId,
      );
      return {
        hasDisplayMessages: lookup.hasDisplayMessages,
        messages: filterSessionMessagesMatchingId(
          projectSqliteHistoryEvents(lookup.events),
          selection.messageId,
        ),
      };
    }
  }
  throw new Error("Unsupported transcript history selection");
}

function visitProjectionMessages(
  projection: CurrentTranscriptProjection,
  visit: (message: unknown, seq: number) => void,
): number {
  let count = 0;
  const visible = resolveVisibleMessagePositions(projection);
  for (const entry of iterateVisibleMessageRange(projection, 0, visible.total)) {
    const message = asOptionalRecord(entry.event)?.message;
    if (message !== undefined) {
      visit(message, entry.seq);
      count += 1;
    }
  }
  return count;
}

/** Apply display visibility to an exact read without reacquiring its archive generation. */
export async function filterSessionMessageHistoryVisibility(
  selected: ReadSessionMessageByIdResult,
  scope: SessionTranscriptReadScope,
  messageId: string,
  visibility: SessionTranscriptMessageByIdOptions["historyVisibility"],
  readers: SessionTranscriptPageReader,
): Promise<ReadSessionMessageByIdResult> {
  const { historyContext, ...result } = selected;
  if (!visibility || !result.found) {
    return result;
  }
  if (
    !dropPreSessionStartAnnouncePairs(
      historyContext?.precedingMessage === undefined
        ? [result.message]
        : [historyContext.precedingMessage, result.message],
      visibility.sessionStartedAt,
    ).includes(result.message)
  ) {
    return { found: false, oversized: false, historyHidden: true };
  }
  if (result.oversized) {
    return {
      found: true,
      oversized: true,
      ...(result.seq === undefined ? {} : { seq: result.seq }),
    };
  }
  if (isPendingAssistantError(result.message)) {
    // Recovery needs later turn context; keep those bounded indexed reads in this worker.
    const archive = historyContext?.transcriptPath
      ? new ArchivedTranscriptReader({
          exactArchivePath: historyContext.transcriptPath,
          sessionId: scope.sessionId,
        })
      : undefined;
    const recoveryReaders = {
      ...readers,
      readSessionMessagesAroundIdWithStatsAsync: archive
        ? (_scope: SessionTranscriptReadScope, options: TranscriptAnchorPageOptions) =>
            archive.readAroundId(options)
        : readers.readSessionMessagesAroundIdWithStatsAsync,
    };
    const createRecovery = () =>
      createChatHistoryRecoveryProjection({
        maxChars: MAX_PAYLOAD_BYTES,
        subagentCoordination: readers.subagentCoordination,
      });
    const recovery = createRecovery();
    recovery.append([result.message]);
    const context = await readChatHistoryRecoveryContext({
      messages: [result.message],
      createRecovery: () => recovery,
      readers: recoveryReaders,
      readScope: scope,
      displaySource: historyContext?.displaySource,
      maxBytes: MAX_PAYLOAD_BYTES,
      sessionStartedAt: visibility.sessionStartedAt,
    });
    // The scanner may stop at a user boundary before appending its final chunk.
    const projected = createRecovery();
    projected.append([result.message, ...context]);
    if (
      !projected
        .result()
        .messages.some((message) => readChatHistoryMessageId(message) === messageId)
    ) {
      return { found: false, oversized: false, historyHidden: true };
    }
  }
  return result;
}

/** Share pagination and archive policy while the caller owns acquisition and restoration. */
export function createSessionTranscriptReader(access: SessionTranscriptReadAccess) {
  async function visitSessionMessagesAsync(
    scope: SessionTranscriptReadScope,
    visit: (message: unknown, seq: number) => void,
  ): Promise<number> {
    const target = await access.resolveTarget(scope);
    return access.readSnapshot(target, (projection) => visitProjectionMessages(projection, visit));
  }

  async function readSessionTranscriptSummaryAsync(
    scope: SessionTranscriptReadScope,
    query: SessionTranscriptSummaryQuery,
  ) {
    const select = await prepareSessionTranscriptSummaryReader(query);
    const target = await access.resolveTarget(scope);
    return access.readSnapshot(target, (projection) =>
      select((visit) => {
        visitProjectionMessages(projection, visit);
      }),
    );
  }

  async function readSnapshotIfPresent<T>(
    target: ResolvedTranscriptReadTarget,
    read: (projection: CurrentTranscriptProjection) => T,
    options?: SessionTranscriptReadOptions,
  ): Promise<T | undefined> {
    try {
      return await access.readSnapshot(target, read, options);
    } catch (error) {
      // Count and exact-ID reads retain their existing missing-store result.
      // History reads suppress the error only to try a reset archive.
      if (
        error instanceof SessionTranscriptStorageUnavailableError &&
        error.reason === "database-missing" &&
        (options === undefined || options.allowResetArchiveFallback === true) &&
        !options?.readOnly
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async function readSessionMessageCountAsync(scope: SessionTranscriptReadScope): Promise<number> {
    const target = await access.resolveTarget(scope);
    return (
      (await readSnapshotIfPresent(target, (projection) =>
        selectSessionTranscriptProjection(projection, { kind: "count" }),
      )) ?? 0
    );
  }

  async function readSessionMessagesAsync(
    scope: SessionTranscriptReadScope,
    opts: ReadSessionMessagesAsyncOptions & SessionTranscriptReadOptions,
  ): Promise<unknown[]> {
    return (await readSessionMessagesWithSourceAsync(scope, opts)).messages;
  }

  async function readSessionMessagesWithSourceAsync(
    scope: SessionTranscriptReadScope,
    opts: ReadSessionMessagesAsyncOptions & SessionTranscriptReadOptions,
  ): Promise<ReadSessionMessagesResult> {
    const target = await access.resolveTarget(scope);
    const snapshot = (await readSnapshotIfPresent(
      target,
      (projection) =>
        selectSessionTranscriptProjection(
          projection,
          { kind: "source", options: opts },
          target.sessionFile,
        ),
      opts,
    )) ?? { messages: [], offPathMessages: [] };
    const result =
      snapshot.messages.length === 0 && opts.allowResetArchiveFallback === true
        ? await archivedTranscriptReader(target).read(opts)
        : { messages: snapshot.messages, transcriptPath: target.sessionFile };
    return snapshot.offPathMessages
      ? { ...result, messages: [...result.messages, ...snapshot.offPathMessages] }
      : result;
  }

  async function readSessionMessageByIdAsync(
    scope: SessionTranscriptReadScope,
    messageId: string,
    opts?: SessionTranscriptMessageByIdOptions & { allowResetArchiveFallback?: boolean },
  ): Promise<ReadSessionMessageByIdResult> {
    const target = await access.resolveTarget(scope);
    const found = await readSnapshotIfPresent(target, (projection) =>
      selectSessionTranscriptProjection(projection, { kind: "by-id", messageId, options: opts }),
    );
    const selected = found?.found
      ? found
      : opts?.allowResetArchiveFallback === true && !opts.currentOnly
        ? await archivedTranscriptReader(target).readById(messageId, opts.historyVisibility)
        : { found: false, oversized: false };
    return filterSessionMessageHistoryVisibility(
      selected,
      scope,
      messageId,
      opts?.historyVisibility,
      {
        ...reader,
        subagentCoordination: access.subagentCoordination,
      },
    );
  }

  /** Read exact membership while retaining full-history validity and empty-only archive fallback. */
  async function readSessionMessagesMatchingIdAsync(
    scope: SessionTranscriptReadScope,
    messageId: string,
  ): Promise<unknown[]> {
    const target = await access.resolveTarget(scope);
    const lookup = await access.readSnapshot(target, (projection) =>
      selectSessionTranscriptProjection(projection, { kind: "lookup", messageId }),
    );
    if (lookup.hasDisplayMessages) {
      return lookup.messages;
    }
    return filterSessionMessagesMatchingId(
      await archivedTranscriptReader(target).readMessageCandidatesById(messageId),
      messageId,
    );
  }

  async function readRecentSessionMessagesWithStatsAsync(
    scope: SessionTranscriptReadScope,
    opts: ReadRecentSessionMessagesOptions &
      TranscriptReadWindowOptions &
      SessionTranscriptReadOptions,
  ): Promise<ReadRecentSessionMessagesResult> {
    const target = await access.resolveTarget(scope);
    const page = (await readSnapshotIfPresent(
      target,
      (projection) =>
        selectSessionTranscriptProjection(
          projection,
          { kind: "recent", options: opts },
          target.sessionFile,
        ),
      opts,
    )) ?? { messages: [], totalMessages: 0 };
    if (
      !page.windowReset &&
      page.totalMessages === 0 &&
      page.messages.length === 0 &&
      opts.allowResetArchiveFallback === true
    ) {
      return await archivedTranscriptReader(target).readRecentWithStats(opts);
    }
    return {
      ...page,
      transcriptPath: target.sessionFile,
      transcriptSource: "active",
    };
  }

  async function readSessionMessagesPageWithStatsAsync(
    scope: SessionTranscriptReadScope,
    opts: SessionTranscriptPageOptions,
  ): Promise<ReadRecentSessionMessagesResult> {
    const target = await access.resolveTarget(scope);
    const page = await readSnapshotIfPresent(
      target,
      (projection) =>
        selectSessionTranscriptProjection(
          projection,
          { kind: "page", options: opts },
          target.sessionFile,
        ),
      opts,
    );
    if (
      (!page || (page.totalMessages === 0 && !page.windowReset)) &&
      opts.allowResetArchiveFallback === true
    ) {
      return await archivedTranscriptReader(target).readPage(opts);
    }
    if (!page) {
      return {
        messages: [],
        totalMessages: 0,
        transcriptPath: target.sessionFile,
        transcriptSource: "active",
      };
    }
    return page;
  }
  /** Reads one message-id-anchored page from a single transcript snapshot. */
  async function readSessionMessagesAroundIdWithStatsAsync(
    scope: SessionTranscriptReadScope,
    opts: TranscriptAnchorPageOptions & SessionTranscriptReadOptions,
  ): Promise<ReadSessionMessagesAroundIdResult> {
    const target = await access.resolveTarget(scope);
    const sessionFile =
      !scope.sessionFile &&
      scope.sessionEntry?.sessionId &&
      scope.sessionEntry.sessionId !== scope.sessionId
        ? undefined
        : target.sessionFile;
    const page = await readSnapshotIfPresent(
      target,
      (projection) =>
        selectSessionTranscriptProjection(
          projection,
          { kind: "around-id", options: opts },
          target.sessionFile,
        ),
      opts,
    );
    if (!page?.found) {
      if (opts.allowResetArchiveFallback === true) {
        return await new ArchivedTranscriptReader({
          agentId: target.agentId,
          sessionFile,
          sessionId: target.sessionId,
          storePath: target.storePath,
        }).readAroundId(opts);
      }
      return {
        found: false,
        hasOverreadContext: false,
        messages: [],
        offset: 0,
        totalMessages: page?.totalMessages ?? 0,
        transcriptPath: target.sessionFile,
      };
    }
    return page;
  }

  const reader = {
    visitSessionMessagesAsync,
    readSessionTranscriptSummaryAsync,
    readSessionMessageCountAsync,
    readSessionMessagesAsync,
    readSessionMessagesWithSourceAsync,
    readSessionMessageByIdAsync,
    readSessionMessagesMatchingIdAsync,
    readRecentSessionMessagesWithStatsAsync,
    readSessionMessagesPageWithStatsAsync,
    readSessionMessagesAroundIdWithStatsAsync,
  };
  return reader satisfies SessionTranscriptReader & SessionTranscriptVisitor;
}
