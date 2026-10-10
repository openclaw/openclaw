import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";
import type { MemoryAudience } from "./memory-provider-types.js";

type PluginHookContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type PluginHookContextWindow = {
  /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number;
  /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: PluginHookContextWindowSource;
  /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
};

export type PluginHookToolAuthority = {
  /** Opaque host fingerprint for the exact turn, route, policy, and active tool surface. */
  readonly fingerprint: string;
  /** Checks whether the finalized turn surface contains this exact tool. */
  allows(toolName: string): boolean;
  /** Rejects retained or timed-out capabilities after the host dispatch closes. */
  assertActive(): void;
};

export type PluginHookAgentContext = PluginHookContextWindow & {
  runId?: string;
  jobId?: string;
  trace?: DiagnosticTraceContext;
  agentId?: string;
  sessionKey?: string;
  /** Heartbeat owner's resolved system-event queue key; supplied to before_agent_reply only. */
  heartbeatEventQueueSessionKey?: string;
  sessionId?: string;
  /** Host-resolved memory partition for this turn. */
  memoryAudience?: MemoryAudience;
  /** Rejects the audience after any captured session incarnation changes. */
  assertMemoryAudienceCurrent?: () => void;
  /** Whether this turn's tool/runtime surface is sandboxed. */
  sandboxed?: boolean;
  workspaceDir?: string;
  /** Run-prepared repository identities; empty when the turn is outside a repository. */
  activeProjectKeys?: string[];
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  /** Channel/plugin id for channel-originated runs, e.g. `discord`. */
  channel?: string;
  /** Channel account used by the agent when multiple accounts are configured. */
  accountId?: string;
  /** Conversation target id for channel-originated runs. Mirrors `channelId` for compatibility. */
  chatId?: string;
  /** Sender identity for channel-originated runs when available. */
  senderId?: string;
  trigger?: string;
  channelId?: string;
  /** Typed origin of the turn's user-role input when supplied by the producer. */
  inputProvenance?: InputProvenance;
  /** @deprecated Use `channelContext.sender` for channel-specific identities. */
  senderExternalId?: string;
  /** Channel-owned sender/chat details. Plugins may augment the nested interfaces. */
  channelContext?: PluginHookChannelContext;
  /** Present only for post-policy prompt enrichment hooks that requested tool authority. */
  toolAuthority?: PluginHookToolAuthority;
  /** Checks this prompt hook handler's result-acceptance lifetime. */
  readonly hookInvocation?: Readonly<{ assertActive(): void }>;
};
