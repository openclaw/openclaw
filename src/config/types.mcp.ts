// Defines MCP server and tool approval configuration types.
import type { McpServerConfigInput } from "./zod-schema.mcp-server.js";

export type McpServerConfig = McpServerConfigInput;
export type McpServerCodexConfig = NonNullable<McpServerConfigInput["codex"]>;
export type McpCodexToolApprovalMode = NonNullable<
  McpServerCodexConfig["defaultToolsApprovalMode"]
>;
export type McpServerToolFilterConfig = NonNullable<McpServerConfigInput["toolFilter"]>;

export type McpConfig = {
  /** Session runtime idle TTL in milliseconds; unset or zero keeps the runtime alive. */
  sessionIdleTtlMs?: number;
  /** Named MCP server definitions managed by OpenClaw. */
  servers?: Record<string, McpServerConfig>;
  /** Opt-in MCP Apps rendering and app-to-server bridge. */
  apps?: {
    enabled?: boolean;
    /** Dedicated public origin that proxies to the sandbox listener. */
    sandboxOrigin?: string;
    /** Dedicated listener port. Defaults to the Gateway port plus one. */
    sandboxPort?: number;
  };
};
