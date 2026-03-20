export type OagConfig = {
  delivery?: {
    maxRetries?: number;
    recoveryBudgetMs?: number;
  };
  lock?: {
    timeoutMs?: number;
    staleMs?: number;
  };
  health?: {
    stalePollFactor?: number;
  };
  notes?: {
    dedupWindowMs?: number;
    maxDeliveredHistory?: number;
  };
  evolution?: {
    /**
     * Whether OAG may automatically apply low-risk config suggestions without operator review.
     * Default: false (opt-in: operators must explicitly enable auto-application of OAG suggestions).
     */
    autoApply?: boolean;
    /** Max single-step change as a percentage of the current value (default: 50). */
    maxStepPercent?: number;
    /** Max cumulative change as a percentage of the original value (default: 200). */
    maxCumulativePercent?: number;
    /** Max evolution notifications per day (default: 3). */
    maxNotificationsPerDay?: number;
    /** Minimum crashes required before analysis kicks in (default: 2). */
    minCrashesForAnalysis?: number;
    /** Cooldown between evolutions in milliseconds (default: 4h). */
    cooldownMs?: number;
    /** Observation window for regression detection in milliseconds (default: 1h). */
    observationWindowMs?: number;
    /** Channel restart threshold for regression detection (default: 5). */
    restartRegressionThreshold?: number;
    /** Delivery failure threshold for regression detection (default: 3). */
    failureRegressionThreshold?: number;
    /** Interval for periodic runtime analysis in milliseconds (default: 6h). */
    periodicAnalysisIntervalMs?: number;
    /** Minimum channel-level incidents to trigger analysis when no gateway crashes (default: 5). */
    minChannelIncidentsForAnalysis?: number;
  };
  scheduler?: {
    /** Maximum wait time before forcing task execution in milliseconds (default: 5min). */
    maxWaitMs?: number;
  };
  memory?: {
    /** Maximum age for lifecycle records in days (default: 30). */
    maxLifecycleAgeDays?: number;
  };
  diagnosis?: {
    /** Which model to use for OAG diagnosis: "lightweight" (built-in) or "embedded" (user's configured LLM). */
    model?: "lightweight" | "embedded";
  };
  /**
   * Delivery watchdog configuration for monitoring message delivery failures.
   * Detects issues like "message too long" and emits anomaly events.
   */
  watchdog?: {
    /** Enable or disable the delivery watchdog (default: true). */
    enabled?: boolean;
    /**
     * Channel-specific text limits for "message too long" detection.
     * Key: channel id (e.g., "telegram", "discord").
     * Value: maximum characters allowed for that channel.
     * If not specified, uses platform defaults.
     */
    channelTextLimits?: Record<string, number>;
    /**
     * Additional error patterns to treat as delivery failures.
     * Patterns are matched against the error message string.
     */
    additionalErrorPatterns?: string[];
  };
  /** Per-channel OAG overrides keyed by channel id (e.g. "telegram", "discord"). */
  channels?: Record<string, Partial<OagConfig>>;
};
