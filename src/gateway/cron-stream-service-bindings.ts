import type { CronService } from "../cron/service.js";
import type { CronStreamOwnerParams } from "./cron-stream-job-owner.js";

type CronStreamServiceBindings = Pick<
  CronStreamOwnerParams,
  "updateState" | "retireSource" | "updateCounters" | "recordFailure"
>;

type CronStreamService = Pick<
  CronService,
  | "updateExternalState"
  | "retireExternalStreamSource"
  | "updateExternalCounters"
  | "recordExternalFailure"
>;

/** Binds stream owner writes to the cron service; a shutdown stop carries its settlement mark through. */
export function createCronStreamServiceBindings(
  cron: CronStreamService,
): CronStreamServiceBindings {
  return {
    updateState: async (jobId, patch, streamScheduleKey, streamSourceIdentity, options) =>
      await cron.updateExternalState(
        jobId,
        streamScheduleKey,
        streamSourceIdentity,
        patch,
        options,
      ),
    retireSource: async (jobId, streamScheduleKey, streamSourceIdentity, options) =>
      await cron.retireExternalStreamSource(
        jobId,
        streamScheduleKey,
        streamSourceIdentity,
        options,
      ),
    updateCounters: async (jobId, counters, options) => {
      await cron.updateExternalCounters(jobId, counters, options);
    },
    recordFailure: async (jobId, error, patch, streamScheduleKey, streamSourceIdentity) => {
      await cron.recordExternalFailure(jobId, error, patch, {
        scheduleKey: streamScheduleKey,
        identity: streamSourceIdentity,
      });
    },
  };
}
