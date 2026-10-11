import type { DefaultProactiveJobReceipt } from "../cron/proactive-job-receipt.types.js";
import type { CronJobScratchState } from "../cron/scratch-contract.js";
import type { CronStoredJob } from "../cron/types.js";
import type { PersistedClawHeartbeatRef } from "./cron.types.js";

export type PortableHeartbeatState = {
  storePath: string;
  receipt: DefaultProactiveJobReceipt | undefined;
  ref: PersistedClawHeartbeatRef | undefined;
  job: CronStoredJob | undefined;
  scratch: CronJobScratchState;
};
