export type McpServerTransport = "stdio" | "sse" | "http";

export type McpServerConfigBase = {
  /** Enable/disable this MCP server entry. Default: true. */
  enabled?: boolean;
  /** Optional display label for UI/logging. */
  label?: string;
};

export type McpStdioServerConfig = McpServerConfigBase & {
  /** Default transport when omitted is "stdio" for parity with common MCP configs. */
  transport?: "stdio";
  /** Executable to spawn (absolute path or on PATH). */
  command: string;
  /** Command arguments. */
  args?: string[];
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  /** Working directory for the server process. */
  cwd?: string;
  /** How to handle server stderr (Node child_process semantics). */
  stderr?: "inherit" | "pipe";
};

export type McpSseServerConfig = McpServerConfigBase & {
  transport: "sse";
  /** Base URL for the MCP SSE endpoint. */
  url: string;
  /** Optional headers for initial SSE and subsequent POST requests. */
  headers?: Record<string, string>;
};

export type McpHttpServerConfig = McpServerConfigBase & {
  transport: "http";
  /** Base URL for the MCP Streamable HTTP endpoint. */
  url: string;
  /** Optional headers for HTTP requests. */
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpSseServerConfig | McpHttpServerConfig;

export type McpServersConfig = Record<string, McpServerConfig>;
