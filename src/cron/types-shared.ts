export type CronAgentScope = {
  agentId?: string | null;
  sessionKey?: string | null;
};

/** Invalid config-backed cron job captured for quarantine instead of runtime load. */
export type QuarantinedCronConfigJob = {
  sourceIndex: number;
  reason: string;
  job?: Record<string, unknown>;
  raw?: unknown;
  state?: Record<string, unknown>;
  updatedAtMs?: number;
  scheduleIdentity?: string;
};

/** Durable recovery record for a cron job skipped during store loading. */
export type CronQuarantinedJob = QuarantinedCronConfigJob & { quarantinedAtMs: number };

/** Optional dynamic-cadence bounds for one cron job. */
export type CronPacing = {
  min?: string;
  max?: string;
};

/** Shared persisted cron job envelope used by runtime and external config shapes. */
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
    pacing?: CronPacing;
    sessionTarget: TSessionTarget;
    wakeMode: TWakeMode;
    payload: TPayload;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
  };
