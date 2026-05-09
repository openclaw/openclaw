export type McpCodexToolApprovalMode = "auto" | "prompt" | "approve";

export type McpServerCodexConfig = {
  /** OpenClaw agent ids that should receive this server in Codex app-server threads. */
  agents?: string[];
  /** Codex MCP tool approval mode emitted as default_tools_approval_mode. */
  defaultToolsApprovalMode?: McpCodexToolApprovalMode;
  /** Codex-native spelling accepted for operator-authored config. */
  default_tools_approval_mode?: McpCodexToolApprovalMode;
};

export type McpServerToolFilterConfig = {
  /**
   * Exact MCP tool names or simple "*" globs to expose from this server.
   *
   * When omitted, all server tools remain eligible unless excluded.
   */
  include?: string[];
  /** Exact MCP tool names or simple "*" globs to hide from this server. */
  exclude?: string[];
};

export type McpServerConfig = {
  /** Set false to keep the saved definition while excluding it from runtime/probe sessions. */
  enabled?: boolean;
  /** Stdio transport: command to spawn. */
  command?: string;
  /** Stdio transport: arguments for the command. */
  args?: string[];
  /** Environment variables passed to the server process (stdio only). */
  env?: Record<string, string | number | boolean>;
  /** Working directory for stdio server. */
  cwd?: string;
  /** Alias for cwd. */
  workingDirectory?: string;
  /** HTTP transport: URL of the remote MCP server (http or https). */
  url?: string;
  /** HTTP transport type for remote MCP servers. */
  transport?: "sse" | "streamable-http";
  /** HTTP transport: extra HTTP headers sent with every request. */
  headers?: Record<string, string | number | boolean>;
  /** Optional connection timeout in milliseconds. */
  connectionTimeoutMs?: number;
  /** Optional connection timeout in seconds. */
  connectTimeout?: number;
  /** Optional per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Optional per-request timeout in seconds. */
  timeout?: number;
  /** Whether this server can safely handle concurrent tool calls. */
  supportsParallelToolCalls?: boolean;
  /** HTTP OAuth mode. Tokens are stored in OpenClaw state, not in config. */
  auth?: "oauth";
  /** Optional OAuth client metadata overrides for HTTP MCP servers. */
  oauth?: {
    scope?: string;
    redirectUrl?: string;
    clientMetadataUrl?: string;
  };
  /** HTTP TLS verification, disabled only for explicitly trusted private endpoints. */
  sslVerify?: boolean;
  /** Alias for sslVerify. */
  ssl_verify?: boolean;
  /** HTTP mutual TLS client certificate path. */
  clientCert?: string;
  /** Alias for clientCert. */
  client_cert?: string;
  /** HTTP mutual TLS client key path. */
  clientKey?: string;
  /** Alias for clientKey. */
  client_key?: string;
  /** Optional per-server OpenClaw MCP tool selection. */
  toolFilter?: McpServerToolFilterConfig;
  /** Codex-specific projection controls for Codex app-server/runtime config. */
  codex?: McpServerCodexConfig;
  [key: string]: unknown;
};

export type McpConfig = {
  /** Named MCP server definitions managed by OpenClaw. */
  servers?: Record<string, McpServerConfig>;
  /**
   * Idle TTL for session-scoped bundled MCP runtimes, in milliseconds.
   *
   * Defaults to 10 minutes. Set to 0 to disable idle eviction.
   */
  sessionIdleTtlMs?: number;
  /**
   * Scope for the bundled MCP runtime cache.
   *
   * - `"session"` (default): one runtime per session. Per-session disposal
   *   tears the runtime down. Matches behavior prior to the introduction of
   *   this flag.
   * - `"shared"`: one runtime per `(workspaceDir, configFingerprint)` tuple.
   *   Multiple sessions can attach to the same runtime; per-session disposal
   *   only detaches the session and disposes the runtime when the last
   *   session detaches. Suitable for single-tenant deployments where every
   *   session shares one workspace and the same MCP server config.
   */
  runtimeScope?: "session" | "shared";
};
