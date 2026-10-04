import type { CronJob } from "./types.js";

type CronToolRuntimeSpec = Pick<CronJob, "payload" | "trigger">;

/** Returns whether a cron job can construct or execute OpenClaw agent tools. */
export function cronJobUsesToolRuntime(job: CronToolRuntimeSpec): boolean {
  return (
    job.payload.kind === "agentTurn" ||
    job.payload.kind === "script" ||
    Boolean(job.trigger?.script.trim())
  );
}
