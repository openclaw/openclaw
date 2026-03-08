export type AlertingWebhookConfig = {
  /** Webhook endpoint for alert delivery. Null disables webhook channel. */
  url?: string | null;
  /**
   * Shared secret for HMAC-SHA256 webhook signing.
   * Stored at: ~/.openclaw/secrets/alerting/webhook.secret
   * Warning logged at startup if url is set but secret is null.
   */
  secret?: string | null;
  /** Number of retry attempts on delivery failure. Default: 2. */
  retries?: number;
  /** Delay between retries in milliseconds. Default: 1000. */
  retryDelayMs?: number;
  /** Webhook request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number;
};

export type AlertingChannelsConfig = {
  webhook?: AlertingWebhookConfig;
};

export type AlertingSuppressionConfig = {
  /** Deduplication window: alerts with same ruleId+agentId+sessionId are suppressed. Default: 5. */
  windowMinutes?: number;
};

export type AlertingRateLimitConfig = {
  /** Maximum alerts delivered per minute before webhook delivery is paused. Default: 20. */
  maxPerMinute?: number;
  /** Maximum alerts delivered per hour before webhook delivery is paused. Default: 100. */
  maxPerHour?: number;
};

export type AlertingRetentionConfig = {
  /** Retention for alert log files and daily summaries in days. Default: 30. */
  days?: number;
};

export type AlertingPayloadConfig = {
  /** Maximum number of recent events included in alert payload context. Default: 20. */
  recentContextMax?: number;
};

export type AlertingIndexConfig = {
  /**
   * TTL for events in the in-memory cross-session index in minutes.
   * Must be >= the largest aggregation window on any rule. Default: 60.
   */
  ttlMinutes?: number;
};

export type AlertingRuleSyntacticFailBurstConfig = {
  /** Number of syntactic_fail events within window that triggers alert. Default: 5. */
  count?: number;
  /** Aggregation window in minutes. Default: 10. */
  windowMinutes?: number;
};

export type AlertingRuleTrustedToolSchemaFailConfig = {
  /** Alert when a trusted MCP tool produces structurally invalid output. Default: true. */
  enabled?: boolean;
};

export type AlertingRuleFrequencyEscalationTierConfig = {
  enabled?: boolean;
};

export type AlertingRuleFrequencyEscalationConfig = {
  tier2?: AlertingRuleFrequencyEscalationTierConfig;
  /**
   * Session termination alerts (tier3) cannot be disabled.
   * This field is present for config documentation only; the value is always treated as true.
   */
  tier3?: AlertingRuleFrequencyEscalationTierConfig;
};

export type AlertingRuleSemanticCatchConfig = {
  enabled?: boolean;
  /** Number of occurrences within 24 hours before severity escalates to high. Default: 3. */
  escalateAfter?: number;
};

export type AlertingRuleWriteFailSpikeConfig = {
  /** Number of write_failed events within window that triggers alert. Default: 3. */
  count?: number;
  /** Aggregation window in minutes. Default: 5. */
  windowMinutes?: number;
};

export type AlertingRulesConfig = {
  syntacticFailBurst?: AlertingRuleSyntacticFailBurstConfig;
  trustedToolSchemaFail?: AlertingRuleTrustedToolSchemaFailConfig;
  frequencyEscalation?: AlertingRuleFrequencyEscalationConfig;
  semanticCatchNoSyntacticFlag?: AlertingRuleSemanticCatchConfig;
  writeFailSpike?: AlertingRuleWriteFailSpikeConfig;
};

export type AlertingConfig = {
  /** Master switch for the alerting layer. Default: true. */
  enabled?: boolean;
  channels?: AlertingChannelsConfig;
  suppression?: AlertingSuppressionConfig;
  rateLimit?: AlertingRateLimitConfig;
  retention?: AlertingRetentionConfig;
  payload?: AlertingPayloadConfig;
  index?: AlertingIndexConfig;
  rules?: AlertingRulesConfig;
};
