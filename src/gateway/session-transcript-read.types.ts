import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
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
  | { kind: "source"; options: ReadSessionMessagesAsyncOptions & SessionTranscriptReadOptions }
  | { kind: "lookup"; messageId: string };

export type SessionTranscriptProjectionSelectionResults = {
  delta: SessionTranscriptDisplayDeltaResult;
  count: number;
  recent: ReadRecentSessionMessagesResult;
  page: ReadRecentSessionMessagesResult;
  "around-id": ReadSessionMessagesAroundIdResult;
  "by-id": ReadSessionMessageByIdResult;
  source: ReadSessionMessagesResult & { offPathMessages?: unknown[] };
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
