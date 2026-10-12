import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";

export type SessionActorMemorySearchReads = {
  "session.history.search": {
    input: Pick<
      SessionTranscriptSearchParams,
      "query" | "limit" | "match" | "role" | "sessionId" | "sessionKeys" | "order"
    >;
    output: SessionTranscriptSearchResult;
  };
};
