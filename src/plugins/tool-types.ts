import type { ToolFsPolicy } from "../agents/tool-fs-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookEntry } from "../hooks/types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { DelegatedAccessTokenProvider } from "./delegated-auth-types.js";

export type { DelegatedAccessTokenProvider } from "./delegated-auth-types.js";

export type DelegatedAccessTokenRequest = {
  provider: DelegatedAccessTokenProvider;
  /** Provider-specific OAuth connection name. Defaults to the channel's configured connection. */
  connectionName?: string;
  /** Expected token audience. Used as a local guard before returning the token to a tool. */
  audience?: string;
  /** Required delegated scopes. Used as a local guard before returning the token to a tool. */
  scopes?: string[];
};

export type DelegatedAccessTokenResult =
  | {
      ok: true;
      token: string;
      expiresAt?: string;
      tenantId?: string;
      userId?: string;
    }
  | {
      ok: false;
      reason: "not_configured" | "missing_consent" | "expired" | "unavailable";
    };

export type OpenClawPluginAuthContext = {
  getDelegatedAccessToken(
    request: DelegatedAccessTokenRequest,
  ): Promise<DelegatedAccessTokenResult>;
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
  browser?: {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
  };
  messageChannel?: string;
  /** Trusted chat type for the active message route. */
  messageChatType?: ChatType;
  agentAccountId?: string;
  /** Trusted ambient delivery route for the active agent/session. */
  deliveryContext?: DeliveryContext;
  /** Trusted sender id from inbound context (runtime-provided, not tool args). */
  requesterSenderId?: string;
  /** Whether the trusted sender is an owner. */
  senderIsOwner?: boolean;
  sandboxed?: boolean;
  /** Runtime-only delegated auth resolver for trusted plugin tools. */
  auth?: OpenClawPluginAuthContext;
};

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;

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
