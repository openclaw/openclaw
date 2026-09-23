import type { AgentHistoryActivity } from "../../infra/agent-activity-events.js";
import type { SessionTranscriptDisplayDeltaResult } from "./session-accessor.sqlite-history-query.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
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

export type SessionHistoryWorkerRequest =
  | { kind: "rpc"; params: ChatHistoryPageParams & { sessionId: string; storePath: string } }
  | { kind: "message-lookup"; params: { target: SessionTranscriptReadScope; messageId: string } }
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
  | { kind: "rpc"; page: ChatHistoryPage }
  | { kind: "message-lookup"; messages: unknown[] }
  | { kind: "recent"; messages: unknown[] }
  | ({ kind: "delta" } & SessionHistoryDelta)
  | { kind: "http"; snapshot: SessionHistorySnapshot };
