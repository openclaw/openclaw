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

export type McpToolAnnotationConfig = {
  /** Relative cost weight for observe-first runtime budget accounting. Defaults to 1. */
  costWeight?: number;
  /** Whether this tool call is considered irreversible for warning/approval hints. */
  irreversible?: boolean;
};

export type McpRuntimeGuardrailsConfig = {
  /** Runtime guardrails are observe-only. Enforcement requires a separate reviewed code change. */
  circuitBreaker?: {
    enabled?: boolean;
    failureThreshold?: number;
    recoveryTimeoutMs?: number;
  };
  budget?: {
    enabled?: boolean;
    warnAfterCallsPerSession?: number;
    warnAfterWeightedCostPerSession?: number;
    warnAfterIrreversibleCallsPerSession?: number;
    burstWindowMs?: number;
    warnAfterCallsPerBurstWindow?: number;
  };
  /** Tool annotations keyed by `server::tool` or `server::*`. */
  tools?: Record<string, McpToolAnnotationConfig>;
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
  /** Warning-only bundled MCP runtime guardrails. */
  runtimeGuardrails?: McpRuntimeGuardrailsConfig;
};
