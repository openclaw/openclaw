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

export type ToolApprovalMode = "selected" | "mutating";

export type ToolApprovalConfig = {
  /** Enable tool-call approvals before execution. Default: false. */
  enabled?: boolean;
  /** Matching mode: explicit tool list or any mutating tool call. Default: selected. */
  mode?: ToolApprovalMode;
  /** Tool names to require approval for when mode=selected. Default: ["apply_patch"]. */
  tools?: string[];
  /** Only require approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only require approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Approval security label shown to operators. Default: full. */
  security?: "deny" | "allowlist" | "full";
  /** Ask policy label shown to operators. Default: always. */
  ask?: "off" | "on-miss" | "always";
  /** Approval request timeout in milliseconds. Default: 120000. */
  timeoutMs?: number;
  /** If true, approval pipeline failures deny the tool call. Default: true. */
  failClosed?: boolean;
  /** Cache duration for allow-always decisions (ms). Default: 21600000 (6h). */
  allowAlwaysTtlMs?: number;
};

export type ApprovalsConfig = {
  exec?: ExecApprovalForwardingConfig;
  tools?: ToolApprovalConfig;
};
