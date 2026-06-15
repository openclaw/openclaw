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
    sessionTarget: TSessionTarget;
    wakeMode: TWakeMode;
    payload: TPayload;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
  };

/** Audit metadata for deterministic command jobs and legacy agentTurn scripts. */
export type CronPayloadAuditExecutionKind =
  | "system-event"
  | "agent-turn"
  | "deterministic-command";

export type CronPayloadAuditWarningCode = "hidden-agent-turn-script";

export type CronPayloadAuditWarning = {
  code: CronPayloadAuditWarningCode;
  severity: "warn";
  message: string;
  recommendation?: string;
};

export type CronPayloadAuditMetadata = {
  executionKind: CronPayloadAuditExecutionKind;
  deterministic: boolean;
  warnings: CronPayloadAuditWarning[];
};
