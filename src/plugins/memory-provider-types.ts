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
