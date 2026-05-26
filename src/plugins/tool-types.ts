import type { ToolFsPolicy } from "../agents/tool-fs-policy.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookEntry } from "../hooks/types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type OpenClawPluginActiveModelContext = {
  provider?: string;
  modelId?: string;
  modelRef?: string;
};

/** Trusted execution context passed to plugin-owned agent tool factories. */
export type OpenClawPluginToolContext = {
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
  /** Trusted sender id from inbound context (runtime-provided, not tool args). */
  requesterSenderId?: string;
  sandboxed?: boolean;
};

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;

export type OpenClawPluginToolOptions = {
  name?: string;
  names?: string[];
  optional?: boolean;
};

export type OpenClawPluginMcpToolOverride = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
};

export type OpenClawPluginMcpServerOptions = {
  /**
   * Optional exact tool-name prefix for MCP tools exposed by this server.
   *
   * When omitted, OpenClaw uses the normal bundle MCP naming convention:
   * `<server>__<tool>`.
   */
  toolNamePrefix?: string;
  /** MCP tool names to expose. Empty or omitted means expose all non-denied tools. */
  allowTools?: string[];
  /** MCP tool names to hide even if `allowTools` is omitted. */
  denyTools?: string[];
  /** Optional presentation/schema overrides keyed by remote MCP tool name. */
  toolOverrides?: Record<string, OpenClawPluginMcpToolOverride>;
};

export type OpenClawPluginMcpServerFactory = (
  ctx: OpenClawPluginToolContext,
) => Record<string, unknown> | null | undefined;

export type OpenClawPluginHookOptions = {
  entry?: HookEntry;
  name?: string;
  description?: string;
  register?: boolean;
};
