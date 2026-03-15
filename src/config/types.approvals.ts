export type ExecApprovalForwardingMode = "session" | "targets" | "both";

export type ExecApprovalForwardTarget = {
  /** Channel id (e.g. "discord", "slack", or plugin channel id). */
  channel: string;
  /** Destination id (channel id, user id, etc. depending on channel). */
  to: string;
  /** Optional account id for multi-account channels. */
  accountId?: string;
  /** Optional thread id to reply inside a thread. */
  threadId?: string | number;
};

export type ExecApprovalForwardingConfig = {
  /** Enable forwarding exec approvals to chat channels. Default: false. */
  enabled?: boolean;
  /** Delivery mode (session=origin chat, targets=config targets, both=both). Default: session. */
  mode?: ExecApprovalForwardingMode;
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Explicit delivery targets (used when mode includes targets). */
  targets?: ExecApprovalForwardTarget[];
};

export type ToolApprovalForwardingConfig = {
  /** Enable forwarding tool approvals to chat channels. Default: false. */
  enabled?: boolean;
  /** Delivery mode (session=origin chat, targets=config targets, both=both). Default: session. */
  mode?: ExecApprovalForwardingMode;
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Explicit delivery targets (used when mode includes targets). */
  targets?: ExecApprovalForwardTarget[];
};

export type ToolApprovalsToolConfig = {
  /** Security mode for MCP/plugin tool calls. Default: "full" (allow all). */
  security?: string;
  /** Ask mode for MCP/plugin tool calls. Default: "off". */
  ask?: string;
  /** Fallback when ask prompt cannot reach an operator. Default: "full". */
  askFallback?: string;
  /** Per-agent tool allowlist overrides. */
  agents?: Record<
    string,
    {
      security?: string;
      ask?: string;
      askFallback?: string;
      allowlist?: Array<{ pattern: string }>;
    }
  >;
  /** Default tool name allowlist entries (apply to all agents unless overridden). */
  allowlist?: Array<{ pattern: string }>;
};

export type ApprovalsConfig = {
  exec?: ExecApprovalForwardingConfig;
  tool?: ToolApprovalForwardingConfig;
  toolPolicy?: ToolApprovalsToolConfig;
};
