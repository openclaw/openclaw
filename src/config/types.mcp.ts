export type McpCodexToolApprovalMode = "auto" | "prompt" | "approve";

export type McpServerCodexConfig = {
  /** OpenClaw agent ids that should receive this server in Codex app-server threads. */
  agents?: string[];
  /** Codex MCP tool approval mode emitted as default_tools_approval_mode. */
  defaultToolsApprovalMode?: McpCodexToolApprovalMode;
  /** Codex-native spelling accepted for operator-authored config. */
  default_tools_approval_mode?: McpCodexToolApprovalMode;
};

export type McpServerToolFilterConfig = {
  /**
   * Exact MCP tool names or simple "*" globs to expose from this server.
   *
   * When omitted, all server tools remain eligible unless excluded.
   */
  include?: string[];
  /** Exact MCP tool names or simple "*" globs to hide from this server. */
  exclude?: string[];
};

export type McpServerConfig = {
  /** Set false to keep the saved definition while excluding it from runtime/probe sessions. */
  enabled?: boolean;
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
  /** Optional connection timeout in seconds. */
  connectTimeout?: number;
  /** Optional per-request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Optional per-request timeout in seconds. */
  timeout?: number;
  /** Whether this server can safely handle concurrent tool calls. */
  supportsParallelToolCalls?: boolean;
  /** HTTP OAuth mode. Tokens are stored in OpenClaw state, not in config. */
  auth?: "oauth";
  /** Optional OAuth client metadata overrides for HTTP MCP servers. */
  oauth?: {
    scope?: string;
    redirectUrl?: string;
    clientMetadataUrl?: string;
  };
  /** HTTP TLS verification, disabled only for explicitly trusted private endpoints. */
  sslVerify?: boolean;
  /** Alias for sslVerify. */
  ssl_verify?: boolean;
  /** HTTP mutual TLS client certificate path. */
  clientCert?: string;
  /** Alias for clientCert. */
  client_cert?: string;
  /** HTTP mutual TLS client key path. */
  clientKey?: string;
  /** Alias for clientKey. */
  client_key?: string;
  /** Optional per-server OpenClaw MCP tool selection. */
  toolFilter?: McpServerToolFilterConfig;
  /** Codex-specific projection controls for Codex app-server/runtime config. */
  codex?: McpServerCodexConfig;
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
    /**
     * How long to wait for a `/approve` reply when the MCP envelope
     * does not specify its own `expires_in_seconds`. Defaults to 5min
     * (300_000ms), tuned for mobile reply channels (WhatsApp/Telegram/
     * SMS) where notification → unlock → context → tap is realistically
     * 60–180s. Hard-capped at 10min (600_000ms); envelope-provided TTLs
     * are also capped at 10min.
     */
    defaultTimeoutMs?: number;
  };
};
