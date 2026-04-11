import type { CronRunOutcome, CronRunTelemetry } from "../types.js";

export type CronExecutionResult = CronRunOutcome &
  CronRunTelemetry & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
  };

export type WaitWithAbort = (ms: number) => Promise<void>;
