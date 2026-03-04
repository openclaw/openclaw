export type CronPostToMainMode = "summary" | "full" | "off";

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
    /** Controls whether isolated job results are posted to the main session.
     *  "summary" (default) posts a short summary, "full" posts the full output,
     *  "off" suppresses the main-session post entirely. */
    postToMainMode?: CronPostToMainMode;
    payload: TPayload;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
  };
