import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { CronStoreSelectionRequiredError } from "../cron/store/selection-error.js";
import type { CronJob } from "../cron/types.js";

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
  storeKey?: string,
): Promise<CronJob[]> {
  const { readDefaultProactiveJobsAsync, readDefaultProactiveJobsByKeyAsync } =
    await import("../cron/proactive-job-receipt.js");
  const jobs = storeKey
    ? await readDefaultProactiveJobsByKeyAsync(storeKey, listAgentIds(cfg))
    : await readDefaultProactiveJobsAsync(storePath, listAgentIds(cfg));
  return resolveHeartbeatSummaryJobs(cfg, jobs);
}

/** Diagnostics stay available while the default cron partition awaits an operator choice. */
export async function readHeartbeatSummaryForStatus(read: () => Promise<CronJob[]>) {
  try {
    return { jobs: await read(), selectionWarning: undefined };
  } catch (error) {
    if (!(error instanceof CronStoreSelectionRequiredError)) {
      throw error;
    }
    return { jobs: [], selectionWarning: error.message };
  }
}

export function projectHeartbeatSummary(job?: CronJob, selectionWarning?: string) {
  const enabled = Boolean(!selectionWarning && job?.enabled && !job.state.autoDisabled);
  const everyMs = job?.schedule.kind === "every" ? job.schedule.everyMs : null;
  return {
    enabled,
    every: selectionWarning
      ? "paused"
      : enabled
        ? everyMs
          ? `${everyMs}ms`
          : "scheduled"
        : "disabled",
    everyMs: enabled ? everyMs : null,
    // The existing diagnostics field carries the actionable pause reason when no job is selected.
    prompt: selectionWarning ?? (job?.payload.kind === "agentTurn" ? job.payload.message : ""),
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
