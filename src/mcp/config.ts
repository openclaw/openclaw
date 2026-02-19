/**
 * MCP configuration types and validation.
 *
 * Defines the schema for MCP server entries in openclaw.json:
 * - agents.defaults.mcp.servers
 * - agents.list[].mcp.servers
 */

export type McpTransport = "stdio" | "sse" | "http";

export type McpServerConfig = {
  /** Enable/disable this server (default: true) */
  enabled?: boolean;

  /** Transport type (default: "stdio") */
  transport?: McpTransport;

  // --- stdio transport ---
  /** Executable command (required for stdio) */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables — supports secret:// URIs */
  env?: Record<string, string>;
  /** Working directory for the child process */
  cwd?: string;

  // --- SSE/HTTP transport ---
  /** Server URL (required for sse/http) */
  url?: string;
  /** HTTP headers — supports secret:// URIs */
  headers?: Record<string, string>;

  // --- Shared ---
  /** Connection timeout in ms (default: 30000) */
  timeout?: number;
  /** Tool call timeout in ms (default: 60000) */
  toolTimeout?: number;
  /** Auto-restart on crash — stdio only (default: true) */
  restartOnCrash?: boolean;
  /** Max restart attempts before giving up (default: 5) */
  maxRestarts?: number;
  /** Custom tool name prefix (default: server key name) */
  toolPrefix?: string;
  /** Enable resource discovery for this server (default: true) */
  resources?: boolean;
  /** Specific resource URIs to subscribe to (empty = all) */
  resourceFilter?: string[];
  /** How often to refresh resources in ms (default: 300000 / 5 min) */
  resourceRefreshMs?: number;
};

export type McpConfig = {
  /** Named MCP server configurations */
  servers?: Record<string, McpServerConfig>;
};
