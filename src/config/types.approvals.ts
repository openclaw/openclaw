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

export type ApprovalsConfig = {
  exec?: ExecApprovalForwardingConfig;
  /**
   * Human-in-the-loop approval integration (HITL.sh).
   *
   * Phase 1: gates outbound side-effects and optionally plugin HTTP routes.
   */
  hitl?: HitlApprovalsConfig;
};

export type HitlApprovalDecision = "allow-once" | "allow-always" | "deny";

export type HitlGateMode = "off" | "on-miss" | "always";

export type HitlGateConfig = {
  /** Gate mode (off|on-miss|always). Default: off. */
  mode?: HitlGateMode;
  /**
   * Allowlist patterns that bypass approvals.
   *
   * Patterns are matched (case-insensitive) against a simple, stable key
   * constructed by the enforcement point (e.g. "slack:to=C123:account=a1").
   */
  allowlist?: string[];
};

export type HitlWebhookConfig = {
  /** Max JSON body bytes for callback endpoint. Default: 256 KiB. */
  maxBodyBytes?: number;
};

export type HitlApprovalsConfig = {
  /** Enable HITL integration. Default: false. */
  enabled?: boolean;
  /** HITL API key (supports ${ENV_VAR} substitution). */
  apiKey?: string;
  /** HITL loop id. */
  loopId?: string;
  /**
   * Callback secret used in the gateway callback path:
   * `POST /hitl/callback/<callbackSecret>`.
   */
  callbackSecret?: string;
  /**
   * Full callback URL used when creating requests (recommended, HTTPS).
   * Example: "https://gateway.example.com/hitl/callback/<secret>"
   */
  callbackUrl?: string;
  /** Default per-request timeout (seconds). Default: 120. */
  timeoutSeconds?: number;
  /** Default decision when a request times out/cancels. Default: deny. */
  defaultDecision?: HitlApprovalDecision;
  /** Outbound side-effects gating configuration. */
  outbound?: HitlGateConfig;
  /** Plugin HTTP route gating configuration. */
  pluginHttp?: HitlGateConfig;
  /** Webhook callback endpoint settings. */
  webhook?: HitlWebhookConfig;
};
