export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string | number | boolean>;
  cwd?: string;
  workingDirectory?: string;
  url?: string;
  [key: string]: unknown;
};

export type McpConfig = {
  /** Named MCP server definitions managed by EVOX.sh. */
  servers?: Record<string, McpServerConfig>;
};
