import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";
import type { MemoryAudience } from "./memory-provider-types.js";

export type PluginHookContextWindow = {
  /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number;
  /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: "model" | "modelsConfig" | "agentContextTokens" | "default";
  /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
};

export type PluginHookToolAuthority = {
  /** Opaque host fingerprint for the exact turn, route, policy, and active tool surface. */
  readonly fingerprint: string;
  /** Checks whether the finalized turn surface contains this exact tool. */
  allows(toolName: string): boolean;
  /** Lists only the frozen canonical tool names checked by allows(); absent on older hosts. */
  list?(): readonly string[];
  /** Rejects retained or timed-out capabilities after the host dispatch closes. */
  assertActive(): void;
};

/** The turn that started a command a later run continues. */
export type PluginHookExecRequestOwner = Readonly<{
  /** Run that called the tool, not a later run that continued it. */
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  /** Verified paired device of the connection that sent the starting turn. */
  ownerDeviceId?: string;
}>;

export type PluginHookAgentContext = PluginHookContextWindow & {
  runId?: string;
  jobId?: string;
  trace?: DiagnosticTraceContext;
  agentId?: string;
  sessionKey?: string;
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
  /**
   * OpenClaw tool names the model could call this turn, after policy. Set on `agent_end`
   * by runtimes that know them; runtime-native tools (such as Codex shell) are not listed.
   */
  toolNames?: readonly string[];
  /**
   * The transcript entry that ended this turn, set on `agent_end` when the runtime recorded one.
   * Pass it as `through` to `api.runtime.subagent.runForkedTurn` to fork the finished turn.
   */
  completedTurn?: { sessionId: string; entryId: string };
  channelId?: string;
  /** Typed origin of the turn's user-role input when supplied by the producer. */
  inputProvenance?: InputProvenance;
  /**
   * True once a tool result in this user turn carried network-sourced content, the same flag
   * that records the turn's memory writes as untrusted. "unknown" when the runtime cannot report it; older hosts may omit it.
   * Informational only: `false` means no network-sourced tool result was seen, not that content is trusted.
   * Memory-flush runs (`trigger: "memory"`) start `true` when the source turn was tainted
   * or the sender was not the owner.
   */
  readonly turnTainted?: boolean | "unknown";
  /** @deprecated Use `channelContext.sender` for channel-specific identities. */
  senderExternalId?: string;
  /** Channel-owned sender/chat details. Plugins may augment the nested interfaces. */
  channelContext?: PluginHookChannelContext;
  /**
   * Paired device id of the Gateway connection that sent this user turn, after the Gateway
   * verified the device signature. Never taken from request params or client info; absent
   * for runs that did not start from a device-authenticated connection.
   */
  requesterDeviceId?: string;
  /**
   * Turns that started the commands this run continues, such as a background exec whose
   * completion this run reports. Set by the host from its exec ownership records, one entry
   * per owning request; absent when the run continues no other request. This is ancestry
   * metadata only: it does not grant the run the starter's authority or approvals.
   */
  execRequestOwners?: readonly PluginHookExecRequestOwner[];
  /** Present only for post-policy prompt enrichment hooks that requested tool authority. */
  toolAuthority?: PluginHookToolAuthority;
  /** Checks this prompt hook handler's result-acceptance lifetime. */
  readonly hookInvocation?: Readonly<{ assertActive(): void }>;
};
