import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "../config/sessions/session-accessor.types.js";
import type {
  TranscriptAnchorPageOptions,
  TranscriptRecentReadLimits,
} from "../sessions/transcript-anchor-page.js";
import type {
  TranscriptReadWindow,
  TranscriptReadWindowOptions,
} from "../sessions/transcript-read-window.js";

export type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";

export type SubagentCoordinationDisplayResolver = {
  assertCurrent?: () => void;
  isSubagentSession: (sessionKey: string) => boolean;
  isSubagentRunMessage: (runId: string, messageSeq: number | undefined) => boolean;
};

export type ReadRecentSessionMessagesOptions = {
  maxMessages: number;
  maxBytes?: number;
  maxLines?: number;
};

export type ReadSessionMessagesAsyncOptions =
  | { mode: "full"; reason: string; includeOffPathMessages?: boolean }
  | ({ mode: "recent" } & ReadRecentSessionMessagesOptions);

export type SessionTranscriptMessageByIdOptions = (
  | { currentOnly?: false; maxBytes?: never }
  | { currentOnly: true; maxBytes: number }
) & { historyVisibility?: { sessionStartedAt?: number } };

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
  nextCursor?: SessionTranscriptSourceCursor;
  snapshot?: SessionTranscriptSourceSnapshot;
};

export type ReadSessionMessageByIdResult = {
  /** A canonical visibility rejection must not fall through to imported history. */
  historyHidden?: true;
  historyContext?: { precedingMessage?: unknown; transcriptPath?: string; displaySource?: string };
  message?: unknown;
  seq?: number;
  oversized: boolean;
  found: boolean;
  serializedBytes?: number;
};

export type SessionTranscriptReadOptions = {
  allowResetArchiveFallback?: boolean;
  readOnly?: boolean;
};

export type SessionTranscriptSourceSnapshot = {
  indexedSeq: number;
  activeEventCount: number;
  totalMessages: number;
  generation: string | undefined;
  tailEventSeq: number | undefined;
  resetSeq: number | null;
};

export type SessionTranscriptSourceCursor = {
  snapshot: SessionTranscriptSourceSnapshot;
  position: number;
  messageSeq: number;
} & ({ kind: "kept" | "active" | "off-path" } | { kind: "archive"; path: string; source: string });

export type SessionTranscriptSourcePageOptions = SessionTranscriptReadOptions & {
  mode: "page";
  includeOffPathMessages?: boolean;
  cursor?: SessionTranscriptSourceCursor;
};

export type ReadSessionMessagesAroundIdResult = ReadRecentSessionMessagesResult & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

export type SessionTranscriptPageOptions = TranscriptReadWindowOptions &
  SessionTranscriptReadOptions & {
    offset: number;
    maxMessages: number;
    beforeSeq?: number;
    recentAtHead?: TranscriptRecentReadLimits;
    maxBytes?: number;
    allowOversizedFirst?: boolean;
  };

export type SessionTranscriptReader = {
  subagentCoordination?: SubagentCoordinationDisplayResolver;
  readSessionMessageCountAsync(scope: SessionTranscriptReadScope): Promise<number>;
  readSessionMessagesWithSourceAsync(
    scope: SessionTranscriptReadScope,
    options: SessionTranscriptSourcePageOptions,
    signal?: AbortSignal,
  ): Promise<ReadSessionMessagesResult>;
  readSessionMessageByIdAsync(
    scope: SessionTranscriptReadScope,
    messageId: string,
    options?: SessionTranscriptMessageByIdOptions & { allowResetArchiveFallback?: boolean },
    signal?: AbortSignal,
  ): Promise<ReadSessionMessageByIdResult>;
  readSessionMessagesMatchingIdAsync(
    scope: SessionTranscriptReadScope,
    messageId: string,
  ): Promise<unknown[]>;
  readRecentSessionMessagesWithStatsAsync(
    scope: SessionTranscriptReadScope,
    options: ReadRecentSessionMessagesOptions &
      TranscriptReadWindowOptions &
      SessionTranscriptReadOptions,
  ): Promise<ReadRecentSessionMessagesResult>;
  readSessionMessagesPageWithStatsAsync(
    scope: SessionTranscriptReadScope,
    options: SessionTranscriptPageOptions,
    signal?: AbortSignal,
  ): Promise<ReadRecentSessionMessagesResult>;
  readSessionMessagesAroundIdWithStatsAsync(
    scope: SessionTranscriptReadScope,
    options: TranscriptAnchorPageOptions & SessionTranscriptReadOptions,
    signal?: AbortSignal,
  ): Promise<ReadSessionMessagesAroundIdResult>;
};

export type SessionTranscriptPageReader = Pick<
  SessionTranscriptReader,
  | "readRecentSessionMessagesWithStatsAsync"
  | "readSessionMessagesPageWithStatsAsync"
  | "readSessionMessagesAroundIdWithStatsAsync"
  | "readSessionMessageByIdAsync"
  | "subagentCoordination"
>;

export type SessionTranscriptVisitor = {
  visitSessionMessagesAsync(
    scope: SessionTranscriptReadScope,
    visit: (message: unknown, seq: number) => void,
  ): Promise<number>;
};

export type SessionTranscriptProjectionSelection =
  | { kind: "delta"; options: SessionTranscriptRawDeltaLimits }
  | { kind: "count" }
  | {
      kind: "recent";
      options: ReadRecentSessionMessagesOptions &
        TranscriptReadWindowOptions &
        SessionTranscriptReadOptions;
    }
  | { kind: "page"; options: SessionTranscriptPageOptions }
  | { kind: "around-id"; options: TranscriptAnchorPageOptions & SessionTranscriptReadOptions }
  | {
      kind: "by-id";
      messageId: string;
      options?: SessionTranscriptMessageByIdOptions & { allowResetArchiveFallback?: boolean };
    }
  | {
      kind: "source";
      options: Parameters<SessionTranscriptReader["readSessionMessagesWithSourceAsync"]>[1];
    }
  | { kind: "lookup"; messageId: string };

export type SessionTranscriptProjectionSelectionResults = {
  delta: SessionTranscriptDisplayDeltaResult;
  count: number;
  recent: ReadRecentSessionMessagesResult;
  page: ReadRecentSessionMessagesResult;
  "around-id": ReadSessionMessagesAroundIdResult;
  "by-id": ReadSessionMessageByIdResult;
  source: ReadSessionMessagesResult;
  lookup: { hasDisplayMessages: boolean; messages: unknown[] };
};

type RawDeltaPage = Extract<SessionTranscriptRawDeltaResult, { kind: "page" }>;
export type SessionTranscriptDisplayDeltaResult =
  | (Omit<RawDeltaPage, "events"> & {
      activeLeafEntryId: string | null;
      events: Array<
        RawDeltaPage["events"][number] & {
          messageSeq?: number;
          displayPosition?: TranscriptDisplayPosition;
        }
      >;
    })
  | Exclude<SessionTranscriptRawDeltaResult, { kind: "page" }>;
