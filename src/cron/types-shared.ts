import type { OperatorScope } from "../gateway/operator-scopes.js";

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
     * The operator scopes of the client who created this job.
     * Stored at job creation time and used during execution to enforce
     * privilege boundaries (prevents a write-scope job from calling
     * admin-only tools when it executes).
     */
    creatorScopes?: OperatorScope[];
  };
