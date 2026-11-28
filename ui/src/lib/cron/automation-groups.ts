import { parseAbsoluteTimeMs } from "../../../../src/cron/parse.js";
import type { CronCompactJob, CronJob } from "../../api/types.ts";

export const automationGroups = ["active", "paused", "history"] as const;
export type AutomationGroup = (typeof automationGroups)[number];

/** A run belongs to the current one-shot only after its occurrence and last schedule change. */
export function automationGroup(job: CronJob | CronCompactJob): AutomationGroup {
  if (job.enabled) {
    return "active";
  }
  const state = "state" in job ? job.state : job;
  const ranAt = state.lastRunAtMs;
  if (
    ranAt == null ||
    state.runningAtMs != null ||
    state.nextRunAtMs != null ||
    state.autoDisabled ||
    state.admissionDeferred ||
    ranAt < (state.scheduleActivatedAtMs ?? 0)
  ) {
    return "paused";
  }
  if (job.schedule?.kind === "at") {
    const at = parseAbsoluteTimeMs(job.schedule.at);
    return at !== null && ranAt >= at ? "history" : "paused";
  }
  return ("scheduleKind" in job ? job.scheduleKind : job.schedule.kind) === "on-exit"
    ? "history"
    : "paused";
}
