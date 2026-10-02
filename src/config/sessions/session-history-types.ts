import type {
  SessionArtifactReadQuery,
  SessionArtifactReadResult,
} from "../../gateway/session-artifact-read.js";
import type {
  ReadRecentSessionMessagesResult,
  ReadSessionMessageByIdResult,
  ReadSessionMessagesAroundIdResult,
  ReadSessionMessagesResult,
  SessionTranscriptReader,
} from "../../gateway/session-transcript-read-kernel.js";
import type {
  SessionTranscriptSummaryQuery,
  SessionTranscriptSummaryResult,
} from "../../gateway/session-transcript-summary.js";
import type { AgentHistoryActivity } from "../../infra/agent-activity-events.js";
import type { ConversationRecord } from "./conversation-registry.js";
import type {
  SessionTranscriptDisplayDeltaResult,
  SessionTranscriptMessageByIdOptions,
} from "./session-accessor.sqlite-history-query.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
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
  omission?: { omittedCount: number; normalizedBytes: number };
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
  completeSnapshot?: true;
};

export type ChatHistoryPage = {
  encodedResponse?: ChatHistoryResponsePage<Uint8Array>;
  windowReset?: boolean;
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  messages: unknown[];
  activity?: AgentHistoryActivity[];
  responseOffset?: number;
  completeCliImport?: true;
  // Absent only for anchored (messageId) reads: the anchor may resolve a
  // reset-archive transcript that numeric offset cursors cannot address, so
  // anchored responses expose no paging metadata.
  pagination?: {
    offset: number;
    totalMessages: number;
    rawPageMessages: number;
    exhausted?: true;
  };
};

export type ChatHistoryPageParams = {
  encodeResponse?: boolean;
  entry: InternalSessionEntry | undefined;
  provider: string | undefined;
  sessionId: string | undefined;
  storePath: string | undefined;
  sessionAgentId: string;
  canonicalKey: string;
  max: number;
  maxHistoryBytes: number;
  effectiveMaxChars: number;
  offset: number | undefined;
  messageId: string | undefined;
  ignoreCliSessionImports?: boolean;
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

export type SessionHistoryWorkerRequest =
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
  | { kind: "rpc"; page: ChatHistoryPage }
  | { kind: "message-lookup"; messages: unknown[] }
  | { kind: "message-by-id"; result: ReadSessionMessageByIdResult }
  | { kind: "message-count"; count: number }
  | { kind: "recent"; messages: unknown[] }
  | ({ kind: "delta" } & SessionHistoryDelta)
  | { kind: "http"; snapshot: SessionHistorySnapshot };
