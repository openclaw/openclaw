import { CronRunReceiptRevisionError } from "./store/run-receipt.types.js";

/** Host-held occurrence authority; never serialized into a tool or transport request. */
export type CronCompletionDeliveryFence = {
  beforeAttempt: () => Promise<void>;
  assertCurrent: () => void;
  /** Diagnostics settle through the captured receipt owner, never delivery authority. */
  recordWithheld?: (outcome: {
    runId: string;
    sessionKey?: string;
    error: string;
  }) => Promise<void>;
};
/** A retained authority can outlive the automation metadata on its follow-up. */
export class CronDeliveryAuthorityError extends CronRunReceiptRevisionError {
  constructor(
    receiptId: string,
    message: string,
    readonly jobId: string,
    readonly fence: CronCompletionDeliveryFence,
    reason?: CronRunReceiptRevisionError["reason"],
  ) {
    super(receiptId, message, reason);
  }
}
