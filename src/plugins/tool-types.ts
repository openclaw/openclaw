// Defines plugin tool metadata and filesystem policy types.
import type { ConversationRecallContext } from "../agents/conversation-recall.types.js";
import type { ToolFsPolicy } from "../agents/tool-fs-policy.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookEntry } from "../hooks/types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type OpenClawPluginActiveModelContext = {
  provider?: string;
  modelId?: string;
  modelRef?: string;
};

/** Current-turn outbound delivery capability bound to the host-selected route and media policy. */
export type OpenClawPluginToolDelivery = {
  send: (params: { text?: string; mediaUrl?: string }) => Promise<void>;
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
  /** Ephemeral session UUID - regenerated on /new and /reset. Use for per-conversation isolation. */
  sessionId?: string;
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
  /** Live host-bound authority. Recheck inside the final synchronous effect/write guard. */
  assertInvocationCurrent?: () => void;
  /**
   * Server-owned origin for this operation. Missing values are delegated.
   * Plugins must use it only for conversation-read visibility policy.
   */
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  sandboxed?: boolean;
  /**
   * True for explicit one-shot local CLI runs that must release plugin-owned
   * process resources before the command exits.
   */
  oneShotCliRun?: boolean;
};

/** Version 1 is the source-compatible direct-turn context; version 2 requires final-effect authority. */
export type OpenClawPluginToolContext<Version extends 1 | 2 = 1> = Version extends 2
  ? OpenClawPluginToolContextBase & { assertInvocationCurrent: () => void }
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
};

export type OpenClawPluginHookOptions = {
  entry?: HookEntry;
  name?: string;
  description?: string;
  register?: boolean;
};
