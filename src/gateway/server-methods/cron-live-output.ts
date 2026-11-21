import { validateCronLiveOutputParams } from "../../../packages/gateway-protocol/src/index.js";
import { readCronCommandLiveOutput } from "../../cron/command-live-output.js";
import { scopedCronJobHandler } from "./cron-job-access.js";

/** Reads the running command job's in-memory tail with the same job gates as `cron.get`. */
export const cronLiveOutputHandler = scopedCronJobHandler(
  "cron.liveOutput",
  validateCronLiveOutputParams,
  ({ params, respond }, { jobId }) =>
    respond(true, readCronCommandLiveOutput(jobId, params), undefined),
  { allowCurrentJob: true, checkVisibility: true },
);
