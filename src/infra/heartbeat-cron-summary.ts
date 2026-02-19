import type { OpenClawConfig } from "../config/config.js";
import type { CronJob, CronSchedule } from "../cron/types.js";
import { loadCronStore, resolveCronStorePath } from "../cron/store.js";

/** Maximum number of cron jobs to include in the heartbeat summary. */
const MAX_JOBS = 15;

function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `once at ${schedule.at}`;
    case "every":
      return `every ${Math.round(schedule.everyMs / 1000 / 60)}m`;
    case "cron":
      return schedule.tz ? `cron "${schedule.expr}" (${schedule.tz})` : `cron "${schedule.expr}"`;
  }
}

function summarizeJob(job: CronJob): string {
  const schedule = formatSchedule(job.schedule);
  const target = job.sessionTarget === "isolated" ? "isolated" : "main";
  const payloadKind = job.payload.kind === "agentTurn" ? "agentTurn" : "systemEvent";
  return `- ${job.name}: ${schedule} [${target}, ${payloadKind}]`;
}

/**
 * Build a compact summary of enabled cron jobs for injection into the heartbeat prompt.
 * Returns `undefined` when no enabled jobs exist or the cron store cannot be read.
 */
export async function buildHeartbeatCronSummary(params: {
  cfg: OpenClawConfig;
}): Promise<string | undefined> {
  try {
    const storePath = resolveCronStorePath(params.cfg.cron?.store);
    const store = await loadCronStore(storePath);
    const enabledJobs = store.jobs.filter((j) => j.enabled);
    if (enabledJobs.length === 0) {
      return undefined;
    }
    const lines = enabledJobs.slice(0, MAX_JOBS).map(summarizeJob);
    if (enabledJobs.length > MAX_JOBS) {
      lines.push(`... and ${enabledJobs.length - MAX_JOBS} more`);
    }
    return [
      "Active cron jobs (do NOT duplicate these in heartbeat — they run automatically):",
      ...lines,
    ].join("\n");
  } catch {
    // Cron store unreadable — skip summary silently.
    return undefined;
  }
}
