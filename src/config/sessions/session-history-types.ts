import type { TranscriptRedactionSnapshot } from "../../agents/transcript-redact-text.js";
import type {
  SessionArtifactReadQuery,
  SessionArtifactReadResult,
} from "../../gateway/session-artifact-read.js";
import type {
  ReadRecentSessionMessagesResult,
  ReadSessionMessageByIdResult,
  ReadSessionMessagesAroundIdResult,
  ReadSessionMessagesResult,
  SessionTranscriptDisplayDeltaResult,
  SessionTranscriptMessageByIdOptions,
  SessionTranscriptReader,
} from "../../gateway/session-transcript-read.types.js";
import type {
  SessionTranscriptSummaryQuery,
  SessionTranscriptSummaryResult,
} from "../../gateway/session-transcript-summary.js";
import type { AgentHistoryActivity } from "../../infra/agent-activity-events.js";
import type { ConversationRecord } from "./conversation-registry.types.js";
import type { LegacyCompactionMetrics } from "./legacy-compaction-history.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
  SessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-projection-read.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import type { StoredMessageReactionSummary } from "./session-reaction-store.types.js";
import type {
  SessionTranscriptAccountingOptions,
  SessionTranscriptAccountingSnapshot,
} from "./session-transcript-accounting.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type ChatHistoryResponsePage<Messages extends unknown[] | Uint8Array = unknown[]> = {
  messages: Messages;
  activity?: AgentHistoryActivity[];
  messagesBytes: number;
  responseHistoryBytes: number;
  omission?: { omittedCount: number; normalizedBytes: number; byteLimited?: true };
  nextOffset?: number;
  olderCursor?: string;
  newerCursor?: string;
  hasMore?: boolean;
  totalMessages?: number;
};

export type ChatHistoryPageCursor = {
  sessionId: string;
  source: string;
  messageId: string;
  direction: "older" | "newer";
};

export type ChatHistoryPageAnchor = Pick<ChatHistoryPageCursor, "sessionId" | "source"> & {
  direction?: ChatHistoryPageCursor["direction"];
  hasOlder: boolean;
  hasNewer: boolean;
  oldestMessageId?: string;
  newestMessageId?: string;
  messageSequences?: Record<string, number>;
};

export type ChatHistoryPage = {
  encodedResponse?: ChatHistoryResponsePage<Uint8Array<ArrayBuffer>>;
  windowReset?: boolean;
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  messages: unknown[];
  activity?: AgentHistoryActivity[];
  responseOffset?: number;
  anchor?: ChatHistoryPageAnchor;
  // Numeric offsets cannot address a retained transcript; anchored pages carry
  // source-bound message cursors instead.
  pagination?: {
    offset: number;
    totalMessages: number;
    rawPageMessages: number;
    messageSequences?: Record<string, number>;
  };
};

export type ChatHistoryPageParams = {
  encodeResponse?: boolean;
  compactionMetrics?: LegacyCompactionMetrics;
  entry: InternalSessionEntry | undefined;
  provider: string | undefined;
  sessionId: string | undefined;
  storePath: string | undefined;
  sessionAgentId: string;
  canonicalKey: string;
  max: number;
  maxHistoryBytes: number;
  responseHistoryBytes?: number;
  effectiveMaxChars: number;
  toolResultMaxChars?: number;
  offset: number | undefined;
  messageId: string | undefined;
  pageCursor?: ChatHistoryPageCursor;
  ignoreCliSessionImports?: boolean;
  cliHistoryHomeDir?: string;
  cliHistoryRedaction?: TranscriptRedactionSnapshot;
};

type SessionHistoryTranscriptMeta = {
  idempotencyKey?: string;
  seq?: number;
  turnBoundary?: boolean;
};

export type SessionHistoryMessage = Record<string, unknown> & {
  __openclaw?: SessionHistoryTranscriptMeta;
};

export type PaginatedSessionHistory = {
  windowReset?: boolean;
  items: SessionHistoryMessage[];
  messages: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore: boolean;
};

export type SessionHistorySnapshot = {
  history: PaginatedSessionHistory;
  rawTranscriptSeq: number;
  turnBoundaryPending: boolean;
  assistantErrorPending: boolean;
  transcriptPath?: string;
};

export type SessionHistoryTranscriptTarget = Pick<
  SessionTranscriptReadScope,
  "agentId" | "env" | "sessionId" | "storePath"
> & {
  sessionEntry?: SessionEntry;
  sessionKey: string;
};

export type SessionHistoryReadParams = {
  target: SessionHistoryTranscriptTarget;
  maxChars?: number;
  limit?: number;
  cursor?: string;
};

export type SessionHistorySubagentLookup =
  | { kind: "session"; sessionKey: string }
  | { kind: "run"; runId: string; messageSeq: number | undefined };

export type SessionHistorySubagentFacts = {
  sessions: Array<[sessionKey: string, hidden: boolean]>;
  runMessages: Array<[runId: string, messageSeq: number | undefined, hidden: boolean]>;
  failure?: { lookup: SessionHistorySubagentLookup; error: SessionTranscriptWorkerReadError };
};

export type SessionHistoryDelta = {
  delta: SessionTranscriptDisplayDeltaResult;
  subagentCoordination: SessionHistorySubagentFacts;
};

export type SessionHistoryTranscriptBinding = { sessionKey: string; sessionId: string };

export type SessionConversationBinding = Pick<
  ConversationRecord,
  "channel" | "accountId" | "target" | "threadId" | "nativeChannelId"
>;

export type ChatHistoryMessageParams = ChatHistoryPageParams & {
  sessionId: string;
  messageId: string;
};
export type ChatHistoryDisplayRequest =
  | { kind: "rpc"; params: ChatHistoryPageParams }
  | { kind: "rpc-message"; params: ChatHistoryMessageParams };
export type ChatHistoryDisplayResult =
  | { kind: "rpc"; page: ChatHistoryPage }
  | { kind: "rpc-message"; result: ReadSessionMessageByIdResult };

export type SessionHistoryWorkerRequest =
  | {
      kind: "catalog-page";
      params: {
        target: SessionTranscriptReadScope;
        options: { offset: number; maxMessages: number; maxBytes: number };
      };
    }
  | {
      kind: "active-accounting";
      params: { target: SessionTranscriptReadScope; options: SessionTranscriptAccountingOptions };
    }
  | {
      kind: "bounded-tail";
      params: {
        target: SessionTranscriptReadScope;
        options: SessionTranscriptBoundedMessageTailOptions;
      };
    }
  | {
      kind: "inline-visibility";
      params: { target: SessionTranscriptReadScope; lookup: SessionHistorySubagentLookup };
    }
  | {
      kind: "summary";
      params: { target: SessionTranscriptReadScope; query: SessionTranscriptSummaryQuery };
    }
  | { kind: "reactions"; params: { target: SessionTranscriptReadScope } }
  | {
      kind: "conversation-binding";
      params: { target: SessionTranscriptReadScope; conversationRef: string };
    }
  | {
      kind: "artifacts";
      params: { target: SessionTranscriptReadScope; query: SessionArtifactReadQuery };
    }
  | {
      kind: "message-page";
      params: {
        target: SessionTranscriptReadScope;
        options: Parameters<SessionTranscriptReader["readSessionMessagesPageWithStatsAsync"]>[1];
      };
    }
  | {
      kind: "around-id";
      params: {
        target: SessionTranscriptReadScope;
        options: Parameters<
          SessionTranscriptReader["readSessionMessagesAroundIdWithStatsAsync"]
        >[1];
      };
    }
  | {
      kind: "source-messages";
      params: {
        target: SessionTranscriptReadScope;
        options: Parameters<SessionTranscriptReader["readSessionMessagesWithSourceAsync"]>[1];
      };
    }
  | {
      kind: "recent-page";
      params: {
        target: SessionTranscriptReadScope;
        exactArchivePath?: string;
        options: Parameters<SessionTranscriptReader["readRecentSessionMessagesWithStatsAsync"]>[1];
      };
    }
  | {
      kind: "transcript-binding";
      params: { target: SessionTranscriptReadScope };
    }
  | { kind: "rpc"; params: ChatHistoryPageParams & { sessionId: string; storePath: string } }
  | { kind: "rpc-message"; params: ChatHistoryMessageParams & { storePath: string } }
  | { kind: "message-lookup"; params: { target: SessionTranscriptReadScope; messageId: string } }
  | {
      kind: "message-by-id";
      params: {
        target: SessionTranscriptReadScope;
        messageId: string;
        options?: SessionTranscriptMessageByIdOptions & { allowResetArchiveFallback?: boolean };
      };
    }
  | { kind: "message-count"; params: { target: SessionTranscriptReadScope } }
  | {
      kind: "recent";
      params: {
        target: SessionTranscriptReadScope;
        maxMessages: number;
        maxLines: number;
        allowResetArchiveFallback?: boolean;
      };
    }
  | {
      kind: "delta";
      params: { target: SessionTranscriptReadScope; limits: SessionTranscriptRawDeltaLimits };
    }
  | { kind: "http"; params: SessionHistoryReadParams };

export type SessionHistoryWorkerResult =
  | { kind: "catalog-page"; result: SessionTranscriptMessageEventPage }
  | { kind: "active-accounting"; result: SessionTranscriptAccountingSnapshot }
  | { kind: "bounded-tail"; result: SessionTranscriptBoundedMessageTailPage }
  | { kind: "inline-visibility"; subagentCoordination: SessionHistorySubagentFacts }
  | { kind: "summary"; result: SessionTranscriptSummaryResult }
  | { kind: "reactions"; result: Record<string, StoredMessageReactionSummary[]> }
  | { kind: "conversation-binding"; result: SessionConversationBinding | null }
  | { kind: "artifacts"; result: SessionArtifactReadResult }
  | { kind: "message-page" | "recent-page"; result: ReadRecentSessionMessagesResult }
  | { kind: "around-id"; result: ReadSessionMessagesAroundIdResult }
  | { kind: "source-messages"; result: ReadSessionMessagesResult }
  | { kind: "transcript-binding"; binding: SessionHistoryTranscriptBinding | undefined }
  | ChatHistoryDisplayResult
  | { kind: "message-lookup"; messages: unknown[] }
  | { kind: "message-by-id"; result: ReadSessionMessageByIdResult }
  | { kind: "message-count"; count: number }
  | { kind: "recent"; messages: unknown[] }
  | ({ kind: "delta" } & SessionHistoryDelta)
  | { kind: "http"; snapshot: SessionHistorySnapshot };
