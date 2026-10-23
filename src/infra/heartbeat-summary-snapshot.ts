import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import type { CronJob } from "../cron/types.js";

type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  session?: string;
  ackMaxChars: number;
};

function resolveHeartbeatSummaryJobs(
  cfg: OpenClawConfig,
  jobs: readonly CronJob[],
): Array<CronJob & { agentId: string }> {
  const defaultAgentId = tryResolveAmbientOwnerAgentId(cfg);
  return jobs.flatMap((job) => {
    const agentId = tryResolveCronJobEffectiveAgentId(job, defaultAgentId);
    return agentId ? [{ ...job, agentId }] : [];
  });
}

/** Missing state is empty; unreadable or unmigrated state remains an explicit failure. */
export async function readHeartbeatSummarySnapshot(
  cfg: OpenClawConfig,
  storePath?: string,
): Promise<CronJob[]> {
  const { readDefaultProactiveJobsAsync } = await import("../cron/proactive-job-receipt.js");
  const jobs = await readDefaultProactiveJobsAsync(storePath, listAgentIds(cfg));
  return resolveHeartbeatSummaryJobs(cfg, jobs);
}

export function projectHeartbeatSummary(job?: CronJob): HeartbeatSummary {
  const enabled = Boolean(job?.enabled && !job.state.autoDisabled);
  const everyMs = job?.schedule.kind === "every" ? job.schedule.everyMs : null;
  return {
    enabled,
    every: enabled ? (everyMs ? `${everyMs}ms` : "scheduled") : "disabled",
    everyMs: enabled ? everyMs : null,
    prompt: job?.payload.kind === "agentTurn" ? job.payload.message : "",
    target:
      job?.delivery?.mode === "none"
        ? "none"
        : (job?.delivery?.target ?? job?.delivery?.channel ?? "none"),
    model: job?.payload.kind === "agentTurn" ? job.payload.model : undefined,
    session: job?.sessionTarget.startsWith("session:")
      ? job.sessionTarget.slice(8)
      : job?.sessionKey,
    ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  };
}
