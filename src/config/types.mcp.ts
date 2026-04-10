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
  /** Per-server tool filter applied after MCP discovery, before materialization. */
  tools?: {
    /** Whitelist of bare tool names to expose. If set, only these tools pass. Must be non-empty. */
    allow?: [string, ...string[]];
    /** Blacklist of bare tool names to hide. Applied after allow (deny wins on overlap). Must be non-empty. */
    deny?: [string, ...string[]];
  };
  [key: string]: unknown;
};

export type McpConfig = {
  /** Named MCP server definitions managed by OpenClaw. */
  servers?: Record<string, McpServerConfig>;
};
