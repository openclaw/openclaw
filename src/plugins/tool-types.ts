import type { ConversationRecallContext } from "../agents/conversation-recall.types.js";
import type { ToolFsPolicy } from "../agents/tool-fs-policy.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookEntry } from "../hooks/types.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { MemoryAudience } from "./memory-provider-types.js";
import type { PluginRequesterModels } from "./model-catalog.types.js";

export type OpenClawPluginActiveModelContext = {
  provider?: string;
  modelId?: string;
  modelRef?: string;
};

/** Current-turn outbound delivery capability bound to the host-selected route and media policy. */
export type OpenClawPluginToolDelivery = {
  send: (params: { text?: string; mediaUrl?: string }) => Promise<void>;
};

/** Commands stay in the calling run's sandbox; paths are sandbox paths, never host paths. */
export type OpenClawPluginToolSandbox = {
  workspaceDir: string;
  /** Only selected, host-installed skills protected by the sandbox owner are exposed. */
  installedSkillRoots: Readonly<Record<string, string>>;
  run: (params: {
    argv: readonly string[];
    input?: string;
    signal?: AbortSignal;
    /** Complete captured bytes per stream, at most the sandbox command buffer limit. */
    maxOutputBytes?: number;
  }) => Promise<{ stdout: string; stderr: string; code: number }>;
};

export type OpenClawPluginToolModelExecution = {
  /** Published CLI entry in the running host installation, never resolved from guest input. */
  readonly cliEntryPath: string;
  /** Admits explicit choices or permitted defaults, retaining the caller through execution. */
  run: <T>(
    selection: { model: string | null; explicit: boolean },
    action: (scope: {
      signal: AbortSignal;
      assertCurrent: () => void;
      model: string;
      agentId: string;
    }) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
};

/** Trusted execution context passed to plugin-owned agent tool factories. */
type OpenClawPluginToolContextBase = {
  config?: OpenClawConfig;
  /** Active runtime-resolved config snapshot when one is available. */
  runtimeConfig?: OpenClawConfig;
  /** Returns the latest runtime-resolved config snapshot for long-lived tool definitions. */
  getRuntimeConfig?: () => OpenClawConfig | undefined;
  /** Effective filesystem policy for the active tool run. */
  fsPolicy?: ToolFsPolicy;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  /** Host-selected reviewer devices for an approval request; not an approval grant. */
  approvalReviewerDeviceIds?: readonly string[];
  /** Ephemeral session UUID - regenerated on /new and /reset. Use for per-conversation isolation. */
  sessionId?: string;
  /** Host run id of the agent turn that builds this tool. Correlation only; never authority. */
  runId?: string;
  /**
   * Host-stamped origin of this turn's input, when its producer supplied one. A background
   * exec completion wake names the run that started the command:
   * `{ kind: "internal_system", sourceTool: "exec", runId }`. A fact for plugin-owned
   * policy; it never grants owner identity.
   */
  inputProvenance?: InputProvenance;
  /** Out-of-band plugin-owned bindings attached by the current run initiator. */
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Host-prepared repository identities for project-aware tool behavior. */
  activeProjectKeys?: readonly string[];
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  /**
   * Runtime-supplied active model metadata for informational use, diagnostics,
   * and plugin-owned policy decisions. This is not a security boundary against
   * the local operator, installed plugin code, or a modified OpenClaw runtime.
   */
  activeModel?: OpenClawPluginActiveModelContext;
  browser?: {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
    /** Prepared local exec parity; not standalone authority or permission for remote browsers. */
    allowLocalLoopback?: boolean;
    assertLocalLoopbackCurrent?: () => void;
  };
  messageChannel?: string;
  agentAccountId?: string;
  /** Trusted provider auth availability from the active auth profile store. */
  hasAuthForProvider?: (providerId: string) => boolean;
  /** Resolves an API key from the active auth profile store when available. */
  resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
  /** Trusted ambient delivery route for the active agent/session. */
  deliveryContext?: DeliveryContext;
  /** Host-bound current-route delivery. Retained copies fail after the owning turn closes. */
  delivery?: OpenClawPluginToolDelivery;
  /** Trusted platform-native conversation id for the active inbound turn. */
  nativeChannelId?: string;
  /** Trusted sender id from inbound context (runtime-provided, not tool args). */
  requesterSenderId?: string;
  /** Trusted owner bit from inbound context (runtime-provided, not tool args). */
  senderIsOwner?: boolean;
  /** Host-resolved memory partition for this turn. Providers must not reconstruct it. */
  memoryAudience?: MemoryAudience;
  /** Stable identity for one provider-owned pre-compaction flush cycle. */
  memoryFlush?: { flushId: string };
  /** Rejects a retained audience after any captured session incarnation changes. */
  assertMemoryAudienceCurrent?: () => void;
  /** Live host-bound authority. Recheck inside the final synchronous effect/write guard. */
  assertInvocationCurrent?: () => void;
  /**
   * Host-bound client-input policy. Pure synchronous guard for final storage admission;
   * performs no database reads and grants no invocation or mutation authority.
   * Omitted for agent-generated input. Do not apply to accepted results or cleanup.
   */
  assertInputCommitAllowed?: () => void;
  /**
   * Server-owned origin for this operation. Missing values are delegated.
   * Plugins must use it only for conversation-read visibility policy.
   */
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  sandboxed?: boolean;
  /** Refuses a complete result that the current direct/full-value route cannot deliver. */
  assertCompleteResult?: (text: string) => void;
  /** Invocation-bound execution, present only for an actual prepared sandbox. */
  sandbox?: OpenClawPluginToolSandbox;
  /** Model authorization scope; does not execute inference or grant tool permissions. */
  modelExecution?: OpenClawPluginToolModelExecution;
  /**
   * True for explicit one-shot local CLI runs that must release plugin-owned
   * process resources before the command exits.
   */
  oneShotCliRun?: boolean;
};

/** Version 1 is the source-compatible direct-turn context; version 2 requires final-effect authority. */
export type OpenClawPluginToolContext<Version extends 1 | 2 = 1> = Version extends 2
  ? OpenClawPluginToolContextBase & {
      assertInvocationCurrent: () => void;
      /** Optional on older hosts and on turns without admitted requester/session authority. */
      runtimeContext?: { models?: PluginRequesterModels };
    }
  : OpenClawPluginToolContextBase;

/** A version 2 descriptor explicitly opts into owner-authorized continuations. */
export type OpenClawPluginToolFactory<Version extends 1 | 2 = 1> = Version extends 2
  ? {
      contextVersion: 2;
      create: (ctx: OpenClawPluginToolContext<2>) => ReturnType<OpenClawPluginToolFactory>;
    }
  : (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;

export type OpenClawPluginToolOptions = {
  name?: string;
  names?: string[];
  optional?: boolean;
  /** False: independent; execute: pure factory with workspace use; true/omitted: factory may use it. */
  workspaceAccess?: boolean | "execute";
  /**
   * System-prompt guidance for these tools. Agent harnesses show it only while one of the
   * named tools is callable in the run, so a denied tool adds no prompt bytes.
   */
  promptGuidance?: string;
};

export type OpenClawPluginHookOptions = {
  entry?: HookEntry;
  name?: string;
  description?: string;
  register?: boolean;
};
