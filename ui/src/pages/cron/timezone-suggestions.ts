import type { CronJob } from "../../api/types.ts";
import { resolveTimezoneSuggestions } from "../../lib/timezone-suggestions.ts";

export function resolveCronTimezoneSuggestions(
  cronJobs: CronJob[],
  browserTimezone?: string,
  supportedTimezones?: string[],
): string[] {
  return resolveTimezoneSuggestions(
    cronJobs.map((job) =>
      job.schedule.kind === "cron" && typeof job.schedule.tz === "string" ? job.schedule.tz : "",
    ),
    browserTimezone,
    supportedTimezones,
  );
}
