import type { CronEventAdmission } from "../event-source.js";
import type { CronServiceRunOptions } from "../service-contract.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronPayload } from "../types.js";

export type ManualRunOptions = {
  event?: CronEventAdmission;
  onEventTransferred?: (receipt: CronRunReceiptHandle) => void;
  runId?: string;
  /** Revalidates the caller before preflight effects and the durable request. */
  commitGuard?: () => void;
  scheduleOwnershipAtMs?: number;
  payload?: CronPayload;
  delivery?: CronServiceRunOptions["delivery"];
  terminalTracker?: { emitted: boolean };
  evaluateTrigger?: boolean;
  streamBatch?: string;
  streamScheduleKey?: string;
  streamSourceIdentity?: string;
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
};
