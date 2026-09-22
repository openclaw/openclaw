import type { AgentHistoryActivity } from "../../infra/agent-activity-events.js";
import type { SessionTranscriptDisplayDeltaResult } from "./session-accessor.sqlite-history-query.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type ChatHistoryPage = {
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
  entry: InternalSessionEntry | undefined;
  provider: string | undefined;
  sessionId: string | undefined;
  storePath: string | undefined;
  sessionAgentId: string;
  canonicalKey: string;
  max: number;
  maxHistoryBytes: number;
  // Undefined lets the display owner apply each message type's default cap.
  effectiveMaxChars: number | undefined;
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

export type SessionHistoryTranscriptTarget = {
  agentId?: string;
  sessionEntry?: SessionEntry;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
};

export type SessionHistoryReadParams = {
  target: SessionHistoryTranscriptTarget;
  maxChars?: number;
  limit?: number;
  cursor?: string;
};

export type SessionHistoryWorkerRequest =
  | { kind: "rpc"; params: ChatHistoryPageParams & { sessionId: string; storePath: string } }
  | { kind: "message-lookup"; params: { target: SessionTranscriptReadScope; messageId: string } }
  | {
      kind: "delta";
      params: { target: SessionTranscriptReadScope; limits: SessionTranscriptRawDeltaLimits };
    }
  | { kind: "http"; params: SessionHistoryReadParams };

export type SessionHistoryWorkerResult =
  | { kind: "rpc"; page: ChatHistoryPage }
  | { kind: "message-lookup"; messages: unknown[] }
  | { kind: "delta"; delta: SessionTranscriptDisplayDeltaResult }
  | { kind: "http"; snapshot: SessionHistorySnapshot };
