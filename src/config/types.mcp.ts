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
   * Channel-mediated approvals for MCP tool calls.
   *
   * When an MCP server returns the standard consent envelope
   * (`{ok: false, requires_confirmation: true, action_id, summary}`)
   * OpenClaw gates the call through the same plugin-approval pipeline
   * that backs `/approve <id> allow-once|allow-always|deny` for shell
   * exec. The model never sees `action_id`, so it cannot self-approve.
   *
   * Servers that don't return the envelope are unaffected.
   */
  approvals?: {
    /**
     * Master switch for the consent gate. Defaults to true (gating is
     * triggered only by MCP servers that opt in via the envelope, so
     * leaving it on is the conservative default).
     */
    enabled?: boolean;
  };
};
