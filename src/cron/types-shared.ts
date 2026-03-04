export type CronJobBase<TSchedule, TSessionTarget, TWakeMode, TPayload, TDelivery, TFailureAlert> =
  {
    id: string;
    agentId?: string;
    sessionKey?: string;
    name: string;
    description?: string;
    enabled: boolean;
    deleteAfterRun?: boolean;
    createdAtMs: number;
    updatedAtMs: number;
    schedule: TSchedule;
    sessionTarget: TSessionTarget;
    wakeMode: TWakeMode;
    payload: TPayload;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
    /**
     * Maximum number of successful runs allowed per calendar day.
     * When set, the scheduler skips execution if the job has already
     * completed this many times today (in the job's configured timezone).
     * Useful for daily tasks that may be triggered by both cron and heartbeats.
     */
    maxRunsPerDay?: number;
  };
