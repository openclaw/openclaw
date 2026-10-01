import type { CronJob, CronStoredJob } from "./types.js";

type CronToolRuntimeSpec = Pick<CronJob, "payload" | "trigger">;

/** Returns whether a cron job can construct or execute OpenClaw agent tools. */
export function cronJobUsesToolRuntime(job: CronToolRuntimeSpec): boolean {
  return (
    job.payload.kind === "agentTurn" ||
    job.payload.kind === "script" ||
    Boolean(job.trigger?.script.trim())
  );
}

/** Stamps an explicit unrestricted cap without changing jobs that already carry one. */
export function applyDefaultCronToolsAllow(job: CronToolRuntimeSpec): void {
  if (cronJobUsesToolRuntime(job) && job.payload.toolsAllow === undefined) {
    job.payload.toolsAllow = ["*"];
  }
}

/**
 * Older builds froze an automatic snapshot of the creator's tools, which could miss
 * tools the creator had. Such an agent turn runs like a `*` job, with its owner
 * conversation's tools; Codex app authority stays bound to the list it was captured with.
 */
export function resolveCronRunToolsAllow(
  job: Pick<CronStoredJob, "payload" | "runtimeAuthority" | "runtimeAuthorityRecoveryRequired">,
): string[] | undefined {
  return job.payload.kind === "agentTurn" &&
    job.payload.toolsAllowIsDefault === true &&
    !job.runtimeAuthority &&
    !job.runtimeAuthorityRecoveryRequired
    ? ["*"]
    : job.payload.toolsAllow;
}
