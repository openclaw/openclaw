import { listAgentIds } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { ProactiveDeliveryPolicy } from "./outbound/targets.js";

export type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  session?: string;
  ackMaxChars: number;
  deliveryPolicy?: ProactiveDeliveryPolicy;
};

const publishedSummaries = new WeakMap<OpenClawConfig, ReadonlyMap<string, HeartbeatSummary>>();

/** Publishes canonical scheduler facts for the synchronous v4 status projection. */
export function publishHeartbeatSummarySnapshot(
  cfg: OpenClawConfig,
  jobs: readonly CronJob[],
): void {
  const summaries = new Map<string, HeartbeatSummary>();
  for (const job of jobs) {
    const agentId = job.agentId ? normalizeAgentId(job.agentId) : "";
    if (!summaries.has(agentId)) {
      summaries.set(agentId, projectHeartbeatSummary(job));
    }
  }
  publishedSummaries.set(cfg, summaries);
}

export function getPublishedHeartbeatSummary(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatSummary {
  const summary = publishedSummaries.get(cfg)?.get(agentId ? normalizeAgentId(agentId) : "");
  return summary
    ? {
        ...summary,
        deliveryPolicy: summary.deliveryPolicy ? { ...summary.deliveryPolicy } : undefined,
      }
    : projectHeartbeatSummary();
}

/** Missing state is empty; unreadable or unmigrated state remains an explicit failure. */
export async function readHeartbeatSummarySnapshot(cfg: OpenClawConfig): Promise<CronJob[]> {
  const { readDefaultProactiveJobsAsync } = await import("../cron/proactive-job-receipt.js");
  const jobs = await readDefaultProactiveJobsAsync(undefined, listAgentIds(cfg));
  return jobs;
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
    deliveryPolicy: job?.delivery
      ? {
          target: job.delivery.target ?? job.delivery.channel,
          channel: job.delivery.channel,
          to: job.delivery.to,
          accountId: job.delivery.accountId,
          directPolicy: job.delivery.directPolicy,
        }
      : undefined,
  };
}
