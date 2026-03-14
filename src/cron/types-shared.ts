export type CronPreHook = {
  kind: "shell";
  command: string;
  /** Timeout in milliseconds (default: 30_000). */
  timeoutMs?: number;
};

export type CronJobHooks = {
  pre?: CronPreHook[];
};

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
    hooks?: CronJobHooks;
  };
