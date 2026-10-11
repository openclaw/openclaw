import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import type { DefaultProactiveJobReceipt } from "../cron/proactive-job-receipt.types.js";
import type { CronStoredJob } from "../cron/types.js";
import type { DoctorCronJob } from "./doctor-heartbeat-jobs.js";
import { resolveHeartbeatAgents } from "./doctor-heartbeat-legacy.js";
import { isHeartbeatTaskCronJob } from "./doctor-heartbeat-task-identity.js";

export function isGeneratedHeartbeatMonitor(job: DoctorCronJob): boolean {
  return job.payload.kind === "heartbeat" && job.declarationKey === `heartbeat:${job.agentId}`;
}

export function selectDoctorHeartbeatMonitor(jobs: readonly DoctorCronJob[], agentId: string) {
  const matches = jobs.filter((job) => job.agentId === agentId && isGeneratedHeartbeatMonitor(job));
  if (matches.length > 1) {
    throw new Error(
      `Multiple legacy monitors for ${agentId}; resolve the duplicate ownership before cutover.`,
    );
  }
  return matches[0];
}

/** A receipt selects the same surviving job for read-only admission and live cutover. */
export function resolveDoctorHeartbeatReceiptJob(
  cfg: OpenClawConfig,
  jobs: readonly DoctorCronJob[],
  agentId: string,
  receipt: DefaultProactiveJobReceipt,
  previous: DoctorCronJob | undefined,
): CronStoredJob | undefined {
  if (previous && previous.id !== receipt.jobId) {
    throw new Error(
      `Agent ${agentId} has a legacy monitor outside its cutover receipt; resolve the conflicting job before stripping legacy configuration.`,
    );
  }
  const current = jobs.find((job) => job.id === receipt.jobId);
  if (!current && receipt.phase !== "complete") {
    throw new Error(
      `Agent ${agentId} has an incomplete cutover whose job ${receipt.jobId} was deleted. Restore the job from backup or resolve its remaining legacy data before rerunning Doctor; it will not be recreated.`,
    );
  }
  if (
    current &&
    receipt.phase !== "complete" &&
    (tryResolveCronJobEffectiveAgentId(current, tryResolveAmbientOwnerAgentId(cfg)) !== agentId ||
      current.payload.kind !== "agentTurn")
  ) {
    throw new Error(
      `Automation ${current.id} changed owner or payload during an incomplete cutover; legacy inputs were retained.`,
    );
  }
  if (current?.payload.kind === "heartbeat") {
    throw new Error(`Automation ${current.id} retained a legacy payload after cutover.`);
  }
  return current ? { ...current, payload: current.payload } : undefined;
}

/** Plan enrollment from the same legacy owners and receipts before inspecting or writing jobs. */
export function planDoctorHeartbeatMonitors(
  cfg: OpenClawConfig,
  jobs: readonly DoctorCronJob[],
  readReceipt: (agentId: string) => DefaultProactiveJobReceipt | undefined,
  legacyFileAgentIds: readonly string[] = [],
) {
  const configuredAgentIds = new Set(listAgentIds(cfg));
  const enrolledAgentIds = new Set([
    ...resolveHeartbeatAgents(cfg)
      .filter((agent) => agent.heartbeat !== undefined)
      .map((agent) => agent.agentId),
    ...legacyFileAgentIds,
  ]);
  const agentIds = new Set(enrolledAgentIds);
  for (const job of jobs) {
    if (job.payload.kind === "heartbeat" || isHeartbeatTaskCronJob(job)) {
      if (!job.agentId) {
        throw new Error(
          `Legacy monitor ${job.id} has no agent owner; assign its owner before Doctor cutover.`,
        );
      }
      if (!configuredAgentIds.has(job.agentId)) {
        throw new Error(
          `Legacy automation ${job.id} belongs to unconfigured agent ${job.agentId}; restore its owner before cutover.`,
        );
      }
      if (
        job.payload.kind === "heartbeat" &&
        job.declarationKey?.startsWith("heartbeat:") &&
        !isGeneratedHeartbeatMonitor(job)
      ) {
        throw new Error(
          `Legacy monitor ${job.id} has conflicting declaration ${job.declarationKey} and agent ${job.agentId}. Restore its original owner/declaration from backup before rerunning Doctor; legacy config and rows were retained.`,
        );
      }
      agentIds.add(job.agentId);
    }
  }
  const receipts = new Map<string, DefaultProactiveJobReceipt>();
  const receiptAgentIds = new Set([
    ...configuredAgentIds,
    ...jobs.flatMap((job) => (job.agentId ? [job.agentId] : [])),
  ]);
  for (const agentId of receiptAgentIds) {
    const receipt = readReceipt(agentId);
    if (!configuredAgentIds.has(agentId)) {
      if (receipt?.phase === "pending") {
        throw new Error(
          `Agent ${agentId} has an incomplete automation cutover for job ${receipt.jobId} but is no longer configured. Restore its owner configuration from backup before rerunning Doctor, or resolve its remaining legacy data manually; the agent and job will not be recreated.`,
        );
      }
      continue;
    }
    if (receipt) {
      receipts.set(agentId, receipt);
      agentIds.add(agentId);
    }
  }
  return { agentIds, enrolledAgentIds, receipts };
}
