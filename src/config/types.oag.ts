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
  };
  scheduler?: {
    /** Maximum wait time before forcing task execution in milliseconds (default: 5min). */
    maxWaitMs?: number;
  };
  memory?: {
    /** Maximum age for lifecycle records in days (default: 30). */
    maxLifecycleAgeDays?: number;
  };
};
