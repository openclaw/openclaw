import {
  normalizeSortedUniqueTrimmedStringList,
  normalizeUniqueTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import type { CronJob } from "../../api/types.ts";

function resolveBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

function resolveSupportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function resolveCronTimezoneSuggestions(
  cronJobs: CronJob[],
  browserTimezone = resolveBrowserTimezone(),
  supportedTimezones = resolveSupportedTimezones(),
): string[] {
  const configuredTimezones = cronJobs.map((job) =>
    job.schedule.kind === "cron" && typeof job.schedule.tz === "string" ? job.schedule.tz : "",
  );
  return normalizeUniqueTrimmedStringList([
    browserTimezone,
    "UTC",
    ...configuredTimezones,
    ...normalizeSortedUniqueTrimmedStringList(supportedTimezones),
  ]);
}
