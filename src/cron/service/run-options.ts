import type { CronEventAdmission } from "../event-source.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronJob, CronPayload } from "../types.js";

export type OnExitRunOptions = {
  schedule: Extract<CronJob["schedule"], { kind: "on-exit" }>;
  signal: AbortSignal;
  commitGuard: () => void;
  onReserved: () => void;
  payload?: (job: CronJob) => CronPayload | undefined;
};

export type ManualRunOptions = {
  event?: CronEventAdmission;
  onEventTransferred?: (receipt: CronRunReceiptHandle) => void;
  onExit?: OnExitRunOptions;
  runId?: string;
  /** Revalidates the caller before preflight effects and the durable request. */
  commitGuard?: () => void;
  scheduleOwnershipAtMs?: number;
  payload?: CronPayload;
  terminalTracker?: { emitted: boolean };
  evaluateTrigger?: boolean;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
};
