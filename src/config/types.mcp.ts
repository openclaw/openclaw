export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string | number | boolean>;
  cwd?: string;
  workingDirectory?: string;
  url?: string;
  /**
   * When true, the MCP server process is kept alive at gateway level and shared across sessions.
   * Only applies to top-level `mcp.servers` entries (not bundle/workspace MCP servers).
   * Only supported for stdio servers (requires `command`).
   * Enables browser tabs, cookies, and login state to persist across agent sessions.
   * This is an explicit opt-in — shared process state is visible to all sessions.
   */
  persistent?: boolean;
  [key: string]: unknown;
};

export type McpConfig = {
  /** Named MCP server definitions managed by OpenClaw. */
  servers?: Record<string, McpServerConfig>;
};
