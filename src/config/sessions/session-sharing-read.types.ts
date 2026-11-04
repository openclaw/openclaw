import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { StoredMessageReactionSummary } from "./session-reaction-store.types.js";
import type { SessionSuggestionListParams } from "./session-sharing-store.types.js";

type SharingInput<Kind extends string> = {
  kind: Kind;
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
};

export type SessionMembersWorkerInput = SharingInput<"session-members"> & {
  sessionKey: string;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionSuggestionsWorkerInput = SharingInput<"session-suggestions"> & {
  sessionKey: string;
  params: SessionSuggestionListParams;
};

export type SessionMembershipFactsWorkerInput = SharingInput<"session-membership-facts"> & {
  sessionKeys?: readonly string[];
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionReactionsWorkerInput = SharingInput<"session-reactions"> & {
  sessionKey: string;
  sessionId: string;
};

export type SessionReactionsWorkerResult = {
  kind: "session-reactions";
  reactions: Record<string, StoredMessageReactionSummary[]>;
};
