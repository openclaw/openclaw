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
  /** Optional connection timeout in milliseconds. */
  connectionTimeoutMs?: number;
  /**
   * When true, bundle MCP merges OpenClaw caller HTTP headers onto this server's
   * remote (`url`) transport: `x-openclaw-agent-id`, `x-openclaw-account-id`,
   * `x-openclaw-message-channel`, and `x-session-key`, using `OPENCLAW_MCP_*`
   * placeholders. Default off (omit or false).
   *
   * Trust requirements (all enforced):
   *  - The flag is honored only in owner-managed `mcp.servers` (this property)
   *    or in OpenClaw runtime-supplied layers (e.g. the loopback gateway
   *    server). Setting it inside a plugin's `.mcp.json` is silently ignored.
   *  - The opt-in entry MUST itself declare a non-empty `url`. A name-only
   *    opt-in is rejected, so an unrelated earlier merge layer (existing
   *    `--mcp-config` file, plugin `.mcp.json`) cannot supply a URL for the
   *    same name and inherit caller headers.
   *  - At apply time the merged URL must still byte-for-byte match the
   *    owner-declared URL; if some other layer rewrote the URL, no caller
   *    headers are attached.
   *
   * Existing user-supplied `headers` (compared case-insensitively, matching
   * HTTP semantics) are never overwritten, and non-string values permitted by
   * `headers` (numbers, booleans) are preserved verbatim.
   */
  injectCallerContext?: boolean;
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
