import type { CronJob, CronJobState } from "../cron/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/index.js";
import type {
  CronStreamFireDisposition,
  CronStreamJob,
  CronStreamLogger,
} from "./cron-stream-output.js";

type DisableStop = "disabled" | "trust-disabled" | "cron-disabled" | "host-execution-disabled";
type LifecycleStop =
  | "removed"
  | "shutdown"
  | "schedule-update"
  | "restart-exhausted"
  | "trigger-disabled";

export type CronStreamStopReason = DisableStop | LifecycleStop;

export type CronStreamOwnerParams = {
  scheduler: GatewayScheduler;
  getDefaultAgentId?: () => string | undefined;
  getProcessSupervisor: () => ProcessSupervisor;
  spawnSandboxSource?: (params: {
    job: CronStreamJob;
    assertCurrent: () => void;
    signal: AbortSignal;
    onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  }) => Promise<ManagedRun>;
  minIntervalMs: number;
  retryBackoffMs?: number[];
  updateState: (
    jobId: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<boolean | void>;
  retireSource: (
    jobId: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<string | undefined>;
  updateCounters?: (
    jobId: string,
    counters: Pick<CronJobState, "streamDroppedBatches" | "streamCoalescedBatches">,
  ) => Promise<void>;
  recordFailure: (
    jobId: string,
    error: string,
    patch: Partial<CronJobState>,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<void>;
  fireBatch: (
    job: CronJob,
    batch: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ) => Promise<CronStreamFireDisposition>;
  logger: CronStreamLogger;
};
