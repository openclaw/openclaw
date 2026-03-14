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
    /** Caller-supplied metadata, persisted with the job and available at execution time.
     *  Cron internals treat this as opaque; channel plugins and tooling may use it
     *  to carry creation-time context (e.g. requester identity, originating chat). */
    metadata?: Record<string, unknown>;
  };
