export type CronJobBase<TSchedule, TSessionTarget, TWakeMode, TPayload, TDelivery, TFailureAlert> =
  {
    id: string;
    agentId?: string;
    sessionKey?: string;
    name: string;
    description?: string;
    enabled: boolean;
    deleteAfterRun?: boolean;
    /** Controls whether each cron run creates a fresh session.
     *  When `true`, always creates a new session each execution.
     *  When `false`, opts into session reuse (context is carried across runs).
     *  When omitted, falls back to the session-target default:
     *  isolated sessions default to fresh, others default to reuse. */
    freshSession?: boolean;
    createdAtMs: number;
    updatedAtMs: number;
    schedule: TSchedule;
    sessionTarget: TSessionTarget;
    wakeMode: TWakeMode;
    payload: TPayload;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
  };
