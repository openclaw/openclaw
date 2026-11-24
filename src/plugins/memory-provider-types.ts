import type { ConversationRecallContext } from "../agents/conversation-recall.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemoryProviderHandle } from "./memory-provider-runtime-types.js";

/** Host-resolved memory partition for one trusted session invocation. */
export type MemoryAudience =
  | { kind: "owner-private"; agentId: string }
  | { kind: "conversation"; agentId: string; sessionKey: string; sessionId: string };

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
      audience?: MemoryAudience;
    }
  | { kind: "host"; operation: string };

/** Facts and a live capability supplied by the trusted host caller. */
export type MemoryCallerContext = {
  authority: MemoryCallerAuthority;
  assertCurrent(): void;
  signal?: AbortSignal;
};

/** A passive memory backend the selected slot owner can open. */
type MemoryBackendInfo = { id: string; name?: string };

/**
 * Host capability passed only to the selected slot owner's `providerRuntime.open()`.
 * Each open reuses that call's caller authority, agent, and purpose. The capability and
 * every backend lease it opened end when the owner's lease closes.
 */
export type MemoryBackendAccess = {
  list(): MemoryBackendInfo[];
  open(backendId: string): Promise<ActiveMemoryProviderResult>;
};

export type MemoryProviderOpenParams = {
  cfg: OpenClawConfig;
  agentId: string;
  context: MemoryCallerContext;
  purpose?: "default" | "status" | "cli";
  /** Present only when the host opens the selected slot owner and memory backends are configured. */
  backends?: MemoryBackendAccess;
};
export type MemoryProviderOpenResult = {
  provider: MemoryProviderHandle | null;
  error?: string;
};
export type ActiveMemoryProviderResult = MemoryProviderOpenResult & {
  providerId?: string;
  adapter?: "native" | "legacy";
};
