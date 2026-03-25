/** MCP server transport type. */
export type McpTransportType = "http" | "sse" | "stdio";

/** Tool naming strategy for an MCP server. */
export type McpToolNaming = "prefixed" | "bare";

/** Tool Search mode override. */
export type McpToolSearchMode = "auto" | "always" | "never";

/** MCP server installation scope. */
export type McpScope = "local" | "project" | "user";

/** Auth configuration for an MCP server (Phase 4: OAuth). */
export interface McpAuthConfig {
  type: "bearer" | "oauth";
  /** Env var name for bearer token. */
  token_env?: string;
  /** OAuth client ID. */
  client_id?: string;
  /** Env var name for OAuth client secret. */
  client_secret_env?: string;
  /** Fixed OAuth callback port. */
  callback_port?: number;
  /** Override OIDC discovery URL. */
  auth_server_metadata_url?: string;
}

/** Configuration for a single MCP server. */
export interface McpServerConfig {
  /** Transport type. */
  type: McpTransportType;
  /** Server URL (required for http/sse). */
  url?: string;
  /** Command to run (required for stdio). */
  command?: string;
  /** Arguments for stdio command. */
  args?: string[];
  /** Working directory for stdio servers (defaults to project root). */
  cwd?: string;
  /** HTTP headers. Supports `${ENV_VAR}` and `${ENV_VAR:-default}` interpolation. */
  headers?: Record<string, string>;
  /** Environment variables passed to stdio process. */
  env?: Record<string, string>;
  /** Auth configuration (Phase 4). */
  auth?: McpAuthConfig;
  /** Whether this server is enabled (default: true). */
  enabled?: boolean;
  /** Per-server timeout in ms (default: 30000). */
  timeout?: number;
  /** Tool naming strategy (default: "prefixed"). */
  toolNames?: McpToolNaming;
  /** Custom prefix for prefixed naming (default: server key). */
  prefix?: string;
  /** Max result bytes before truncation (default: global maxResultBytes). */
  maxResultBytes?: number;
}

/** Configuration for an MCP registry. */
export interface McpRegistryConfig {
  id: string;
  name: string;
  url: string;
  description?: string;
  /** Env var name for registry auth token. */
  auth_token_env?: string;
  visibility?: "public" | "private";
  /** Whether this registry is enabled (default: true). */
  enabled?: boolean;
}

/** Top-level MCP configuration (nested under tools.mcp). */
export interface McpConfig {
  /** Global max result bytes before truncation (default: 102400). */
  maxResultBytes?: number;
  /** Tool count threshold for switching to Tool Search mode (default: 15). */
  toolSearchThreshold?: number;
  /** Tool Search mode override. */
  toolSearch?: McpToolSearchMode;
  /** Configured registries. */
  registries?: McpRegistryConfig[];
  /** Configured servers keyed by server name. */
  servers?: Record<string, McpServerConfig>;
  /**
   * Per-agent server restrictions. Keys are agent ids, values are arrays of
   * allowed server keys. Agents not listed get access to all servers (default open).
   */
  agentScopes?: Record<string, string[]>;
}

/** Entry in the in-memory tool search index. */
export interface ToolIndexEntry {
  /** Resolved tool name (prefixed or bare). */
  name: string;
  /** Original tool name from the MCP server. */
  originalName: string;
  /** Server key this tool belongs to. */
  serverKey: string;
  /** Human-readable description from the MCP server. */
  description: string;
  /** Raw JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Parameter names for compact display. */
  parameterNames: string[];
}

/** Health status for a connected MCP server. */
export type McpServerStatus = "connected" | "degraded" | "unavailable" | "disabled";

/** Runtime state for a managed MCP server. */
export interface McpServerState {
  /** Server key from config. */
  key: string;
  /** Current connection status. */
  status: McpServerStatus;
  /** Transport type. */
  type: McpTransportType;
  /** Number of discovered tools. */
  toolCount: number;
  /** Discovered tool names. */
  toolNames: string[];
  /** Last error message if unavailable. */
  lastError?: string;
  /** Timestamp of last successful tool call. */
  lastCallAt?: number;
  /** Average call latency in ms. */
  avgLatencyMs?: number;
}

/** Default values for MCP configuration. */
export const MCP_DEFAULTS = {
  maxResultBytes: 102_400,
  toolSearchThreshold: 15,
  timeout: 30_000,
  initTimeout: 30_000,
  toolSearch: "auto" as McpToolSearchMode,
  toolNames: "prefixed" as McpToolNaming,
} as const;
