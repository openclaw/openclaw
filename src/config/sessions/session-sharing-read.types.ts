import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionSuggestionListParams } from "./session-sharing-store.types.js";

export type SessionMembersWorkerInput = {
  kind: "session-members";
  database: { agentId: string; path: string };
  sessionKey: string;
  env: NodeJS.ProcessEnv;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionSuggestionsWorkerInput = {
  kind: "session-suggestions";
  database: { agentId: string; path: string };
  sessionKey: string;
  params: SessionSuggestionListParams;
  env: NodeJS.ProcessEnv;
};

export type SessionMembershipFactsWorkerInput = {
  kind: "session-membership-facts";
  database: { agentId: string; path: string };
  sessionKeys?: readonly string[];
  env: NodeJS.ProcessEnv;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionReactionsWorkerInput = {
  kind: "session-reactions";
  database: { agentId: string; path: string };
  sessionKey: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
};
