type SessionTranscriptSearchHit = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "assistant" | "user";
  timestamp: number;
  snippet: string;
  score: number;
};

export type SessionTranscriptSearchResult = {
  hits: SessionTranscriptSearchHit[];
  indexing: boolean;
  truncated: boolean;
  archivedTranscriptsExcluded?: number;
};

export type SessionTranscriptSearchReadResult = Omit<SessionTranscriptSearchResult, "indexing"> & {
  found: boolean;
};

export type SessionTranscriptSearchParams = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  query: string;
  /** Interactive search completes the final word; tool queries retain exact terms. */
  match?: "prefix";
  role?: "assistant" | "user";
  sessionId?: string;
  sessionKeys?: string[];
  order?: "relevance" | "recent";
  storePath?: string;
  sessionKey?: string;
};
