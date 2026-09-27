import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "../config/sessions/session-accessor.sqlite-contract.js";
import { resolveVisibleHistoryEventCount } from "../config/sessions/session-accessor.sqlite-history-projection.js";
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
import {
  iterateVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "../config/sessions/session-accessor.sqlite-reset-window.js";
import { SessionTranscriptStorageUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
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
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";
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
  windowReset?: boolean;
  messages: unknown[];
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "active" | "reset-archive";
  totalMessages: number;
};

export type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

export type ReadSessionMessageByIdResult = {
  message?: unknown;
  seq?: number;
  oversized: boolean;
  found: boolean;
  serializedBytes?: number;
};

type SessionTranscriptReadOptions = {
  allowResetArchiveFallback?: boolean;
  readOnly?: boolean;
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

function normalizeRecentSqliteReadOptions(
  opts?: Partial<ReadRecentSessionMessagesOptions> &
    TranscriptReadWindowOptions & { readOnly?: boolean },
) {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  return {
    maxMessages,
    maxBytes: resolveIntegerOption(opts?.maxBytes, 8 * 1024 * 1024, { min: 1024 }),
    maxLines: resolveIntegerOption(opts?.maxLines, maxMessages * 20 + 20, { min: maxMessages }),
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
  windowReset?: boolean;
  messages: unknown[];
  totalMessages: number;
} {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const page = readRecentSessionTranscriptHistoryEventsFromProjection(projection, normalized);
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

export type ReadSessionMessagesAroundIdResult = ReadRecentSessionMessagesResult & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

/** Share pagination and archive policy while the caller owns acquisition and restoration. */
export function createSessionTranscriptReader(access: SessionTranscriptReadAccess) {
  async function visitSessionMessagesAsync(
    scope: SessionTranscriptReadScope,
    visit: (message: unknown, seq: number) => void,
  ): Promise<number> {
    const target = await access.resolveTarget(scope);
    return access.readSnapshot(target, (projection) => {
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
    });
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
    return (await readSnapshotIfPresent(target, resolveVisibleHistoryEventCount)) ?? 0;
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
    const messages =
      (await readSnapshotIfPresent(
        target,
        (projection) =>
          opts.mode === "recent"
            ? readRecentSqliteMessageRecords(projection, opts).messages
            : projectSqliteHistoryEvents(
                readSessionTranscriptHistoryEventsFromProjection(projection),
              ),
        opts,
      )) ?? [];
    if (messages.length === 0 && opts.allowResetArchiveFallback === true) {
      return await archivedTranscriptReader(target).read(opts);
    }
    return {
      messages,
      transcriptPath: target.sessionFile,
    };
  }

  async function readSessionMessageByIdAsync(
    scope: SessionTranscriptReadScope,
    messageId: string,
    opts?: SessionTranscriptMessageByIdOptions & { allowResetArchiveFallback?: boolean },
  ): Promise<ReadSessionMessageByIdResult> {
    const target = await access.resolveTarget(scope);
    const foundEvent = await readSnapshotIfPresent(target, (projection) =>
      readSessionTranscriptHistoryEventByIdFromProjection(projection, messageId, opts),
    );
    if (foundEvent) {
      return {
        found: true,
        message: sqliteMessageEventWithSeq(foundEvent),
        oversized: false,
        seq: foundEvent.seq,
        ...(foundEvent.serializedBytes !== undefined
          ? { serializedBytes: foundEvent.serializedBytes }
          : {}),
      };
    }
    if (opts?.allowResetArchiveFallback === true && !opts.currentOnly) {
      return await archivedTranscriptReader(target).readById(messageId);
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
      : await archivedTranscriptReader(target).readMessageCandidatesById(messageId);
    return messages.filter(
      (message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id === messageId,
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
      (projection) => readRecentSqliteMessageRecords(projection, opts),
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
    opts: TranscriptReadWindowOptions &
      SessionTranscriptReadOptions & {
        offset: number;
        maxMessages: number;
        beforeSeq?: number;
        recentAtHead?: TranscriptRecentReadLimits;
        maxBytes?: number;
      },
  ): Promise<ReadRecentSessionMessagesResult> {
    const target = await access.resolveTarget(scope);
    const page = await readSnapshotIfPresent(
      target,
      (projection) => readSessionTranscriptHistoryEventPageFromProjection(projection, opts),
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
      transcriptPath: target.sessionFile,
      transcriptSource: "active",
    };
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
      (projection) => readSessionTranscriptHistoryAnchorPageFromProjection(projection, opts),
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
    return {
      found: true,
      ...(page.windowReset ? { windowReset: true } : {}),
      ...(page.readWindow ? { readWindow: page.readWindow } : {}),
      displaySource: page.displaySource,
      hasOverreadContext: page.hasOverreadContext,
      messages: page.events
        .map(sqliteMessageEventWithSeq)
        .filter((message) => message !== undefined),
      offset: page.offset,
      totalMessages: page.totalMessages,
      transcriptPath: target.sessionFile,
    };
  }

  return {
    visitSessionMessagesAsync,
    readSessionMessageCountAsync,
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
