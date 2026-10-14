import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import type { CronJob, CronStoredJob } from "./types.js";

type CronToolRuntimeSpec = Pick<CronJob, "payload" | "trigger" | "precheck">;

/** Returns whether a cron job can construct or execute OpenClaw agent tools. */
export function cronJobUsesToolRuntime(job: {
  payload?: { kind?: unknown };
  trigger?: { script?: unknown };
  precheck?: { command?: unknown };
}): boolean {
  const hasPrecheckCommand =
    typeof job.precheck?.command === "string" && job.precheck.command.trim().length > 0;
  return (
    job.payload?.kind === "agentTurn" ||
    job.payload?.kind === "script" ||
    (typeof job.trigger?.script === "string" && job.trigger.script.trim().length > 0) ||
    // Host-shell precheck is an executable surface: stamp toolsAllow so capless
    // systemEvent/heartbeat/command jobs cannot inherit unrestricted undefined.
    hasPrecheckCommand
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
 * conversation's tools. Condition triggers keep their list (scripts reach MCP only
 * through named servers), as do jobs without a valid owner policy or whose Codex app
 * authority is bound to the captured list.
 */
export function resolveCronRunToolsAllow(
  job: Pick<
    CronStoredJob,
    | "payload"
    | "trigger"
    | "owner"
    | "scheduledToolPolicy"
    | "runtimeAuthority"
    | "runtimeAuthorityRecoveryRequired"
  >,
): string[] | undefined {
  return job.payload.kind === "agentTurn" &&
    job.payload.toolsAllowIsDefault === true &&
    !job.trigger?.script.trim() &&
    !job.runtimeAuthority &&
    !job.runtimeAuthorityRecoveryRequired &&
    resolveCronScheduledToolPolicy({
      toolsAllow: job.payload.toolsAllow,
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    })
    ? ["*"]
    : job.payload.toolsAllow;
}
