export type OverseerPlannerConfig = {
  model?: string;
  maxPlanPhases?: number;
  maxTasksPerPhase?: number;
  maxSubtasksPerTask?: number;
  maxRepairAttempts?: number;
};

export type OverseerConfig = {
  enabled?: boolean;
  tickEvery?: string;
  idleAfter?: string;
  maxRetries?: number;
  minResendInterval?: string;
  backoff?: {
    base?: string;
    max?: string;
  };
  planner?: OverseerPlannerConfig;
  policy?: {
    allowAgents?: string[];
    allowCrossAgent?: boolean;
  };
  storage?: {
    dir?: string;
  };
};
