export type GuardrailRequest = {
  /** Normalized tool name (e.g. "exec", "write", "browser", "mcp.tool_name"). */
  toolName: string;
  /** Tool input parameters. */
  toolInput: Record<string, unknown>;
  /** Agent identifier, if available. */
  agentId?: string;
  /** Session key, if available. */
  sessionId?: string;
  /** Stable run identifier. */
  runId?: string;
  /** Provider-specific tool call identifier. */
  toolCallId?: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
};

export type GuardrailReason = {
  /** Machine-readable code (e.g. "tool_not_allowed", "allowed"). */
  code: string;
  /** Human-readable explanation. */
  message?: string;
};

export type GuardrailDecision = {
  /** Whether the tool call should proceed. */
  allow: boolean;
  /** Structured reasons for the decision. May be omitted by external providers. */
  reasons?: GuardrailReason[];
  /** Identifier of the policy that produced this decision. */
  policyId?: string;
  /** Provider-specific metadata (audit ID, signature, etc.). */
  metadata?: Record<string, unknown>;
};

export type GuardrailProvider = {
  /** Provider name for logging and diagnostics. */
  name: string;
  /** Evaluate whether a tool call should proceed. */
  evaluate(request: GuardrailRequest): Promise<GuardrailDecision>;
  /** Optional health check for startup validation. */
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
};

export type GuardrailProviderConfig = {
  /** Module specifier: "builtin:allowlist", "@scope/package", or "./path/to/provider.js". */
  use: string;
  /** Provider-specific configuration passed to the constructor. */
  config?: Record<string, unknown>;
};

export type GuardrailsConfig = {
  /** Enable guardrail evaluation. Default: false. */
  enabled?: boolean;
  /** Block tool calls when the provider throws an error. Default: true. */
  failClosed?: boolean;
  /** Provider configuration. Required when enabled is true. */
  provider?: GuardrailProviderConfig;
};
