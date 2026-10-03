import type { ConversationRecallContext } from "../agents/conversation-recall.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Authenticated caller authority supplied by the trusted host, never inferred from IDs. */
export type MemoryCallerAuthority =
  | { kind: "operator"; scopes: readonly string[]; connId?: string }
  | {
      kind: "session";
      sessionKey: string;
      sandboxed: boolean;
      /** Host-granted bounded recall pass; the memory owner decides which hits it admits. */
      conversationRecall?: ConversationRecallContext;
      sessionId?: string;
      senderIsOwner?: boolean;
      chatType?: "direct" | "group" | "channel";
    }
  | { kind: "host"; operation: string };

/** Facts and a live capability supplied by the trusted host caller. */
export type MemoryCallerContext = {
  authority: MemoryCallerAuthority;
  assertCurrent(): void;
  signal?: AbortSignal;
};

/** Opaque identity, scoped to its provider. A reference is not an authorization grant. */
export type MemoryReference = {
  providerId: string;
  id: string;
  revision?: string;
  fragment?: string;
};
export type MemoryCitation = {
  label: string;
  reference?: MemoryReference;
  url?: string;
  startLine?: number;
  endLine?: number;
};
export type MemorySearchHit = {
  reference: MemoryReference;
  excerpt: string;
  score?: number;
  source?: string;
  citations?: MemoryCitation[];
  /** Provider-owned trusted selection facts; missing eligibility never permits injection. */
  automaticRecall?: {
    eligible: boolean;
    projectKeys?: readonly string[];
    triggers?: string;
    importance?: number;
  };
};
export type MemorySearchPage = {
  hits: MemorySearchHit[];
  nextCursor?: string;
  coverage?: "complete" | "partial";
  warning?: string;
};
export type MemorySearchRequest = {
  query: string;
  maxResults?: number;
  /** Minimum score every provider must enforce. */
  minScore?: number;
  cursor?: string;
  sources?: ("memory" | "sessions")[];
  /** Provider hint that may be ignored when lexical-only search is unavailable. */
  lexicalOnly?: boolean;
  activeProjectKeys?: readonly string[];
};
export type MemoryGetRequest = { reference: MemoryReference; from?: number; lines?: number };
export type MemoryGetResult =
  | {
      status: "ok";
      reference: MemoryReference;
      text: string;
      citations?: MemoryCitation[];
      truncated?: boolean;
      from?: number;
      lines?: number;
      nextFrom?: number;
    }
  | { status: "not_found" };
export type MemoryHealth = {
  status: "ready" | "degraded" | "unavailable";
  message?: string;
  details?: Record<string, unknown>;
};
export type MemoryCandidateRequest = {
  kind: "trigger" | "project";
  limit?: number;
  activeProjectKeys?: readonly string[];
};
export type MemoryProviderCapabilities = {
  /** Corpora search can cover. Non-empty. */
  sources: readonly ("memory" | "sessions")[];
  /** search accepts `cursor` and may return `nextCursor`. */
  pagination: boolean;
  /** Candidate kinds `candidates()` can enumerate for automatic recall. */
  candidates: readonly ("trigger" | "project")[];
  /** search honours `activeProjectKeys` as a filter. */
  projectFilter: boolean;
};

/** A caller-bound lease. close releases this lease, not another caller's cached manager. */
export type MemoryProviderHandle = {
  capabilities: MemoryProviderCapabilities;
  search(request: MemorySearchRequest): Promise<MemorySearchPage>;
  get(request: MemoryGetRequest): Promise<MemoryGetResult>;
  /**
   * Report readiness without revealing partition content. This must be answerable for every
   * authenticated caller, including host authority with the `status` purpose; search/get may deny.
   */
  health(): Promise<MemoryHealth>;
  candidates?(request: MemoryCandidateRequest): Promise<MemorySearchPage>;
  refresh?(): Promise<void>;
  close(): Promise<void>;
};
export type MemoryProviderOpenParams = {
  cfg: OpenClawConfig;
  agentId: string;
  context: MemoryCallerContext;
  purpose?: "default" | "status" | "cli";
};
export type MemoryProviderOpenResult = {
  provider: MemoryProviderHandle | null;
  error?: string;
};
export type ActiveMemoryProviderResult = MemoryProviderOpenResult & {
  providerId?: string;
  adapter?: "native" | "legacy";
};
