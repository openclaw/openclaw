export type McpServerConfig = {
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
  /** Optional OAuth resource/audience hints for remote HTTP MCP bearer-token guardrails. */
  oauth?: {
    /** Expected OAuth resource indicator for this MCP resource server. Must share the server URL origin. */
    resource?: string;
    /** Expected token audience for this MCP resource server. Must share the server URL origin when URL-shaped. */
    audience?: string;
    /** Protected Resource Metadata URL advertised by the MCP server. Must share the server URL origin. */
    protectedResourceMetadataUrl?: string;
  };
  /** Optional connection timeout in milliseconds. */
  connectionTimeoutMs?: number;
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
};
