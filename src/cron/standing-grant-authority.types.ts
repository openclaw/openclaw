import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { CronRunReceiptHandle } from "./store/run-receipt.types.js";

/** Existing run and Gateway checks carried to standing-grant consumption. */
export type CronStandingGrantAuthority = {
  context: OpenClawStateWorkerContext;
  handle: CronRunReceiptHandle;
  assertCurrent: () => void;
};
