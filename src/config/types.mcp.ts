export type McpServerConfig = {
  /** Stdio transport: command to spawn. */
  command?: string;
  /** Stdio transport: arguments for the command. */
  args?: string[];
  /** Environment variables passed to the server process (stdio) or as headers (SSE). */
  env?: Record<string, string | number | boolean>;
  /** Working directory for stdio server. */
  cwd?: string;
  /** Alias for cwd. */
  workingDirectory?: string;
  /** SSE transport: URL of the remote MCP server (http or https). */
  url?: string;
  /** SSE transport: extra HTTP headers sent with every request. */
  headers?: Record<string, string>;
  [key: string]: unknown;
};

export type McpConfig = {
  /** Named MCP server definitions managed by OpenClaw. */
  servers?: Record<string, McpServerConfig>;
};
