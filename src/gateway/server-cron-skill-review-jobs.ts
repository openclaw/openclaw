// Converges the system-owned skill collection review jobs at startup and reload.
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSkillCollectionReviewMonitorSpecs,
  skillCollectionReviewMonitorAgentId,
} from "../cron/skill-collection-review-monitor.js";
import { partitionSystemMonitors } from "../cron/system-monitor-jobs.js";
import type { CronJob } from "../cron/types.js";
import { resolveHeartbeatSchedulerSeedAsync } from "../infra/heartbeat-schedule.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

type SkillReviewJobCron = Pick<GatewayCronServiceContract, "add" | "list" | "remove">;

export async function reconcileSkillCollectionReviewJobs(params: {
  cron: SkillReviewJobCron;
  cfg: OpenClawConfig;
  schedulerSeed?: string;
  logger: { warn: (obj: unknown, msg?: string) => void };
  commitGuard?: () => void;
}): Promise<{ ok: boolean }> {
  let ok = true;
  let jobs: CronJob[];
  try {
    jobs = await params.cron.list({ includeDisabled: true });
  } catch (error) {
    params.logger.warn({ err: String(error) }, "cron-skill-review: monitor inventory failed");
    return { ok: false };
  }
  params.commitGuard?.();

  const schedulerSeed = await resolveHeartbeatSchedulerSeedAsync(params.schedulerSeed);
  params.commitGuard?.();
  const specs = resolveSkillCollectionReviewMonitorSpecs(params.cfg, jobs, { schedulerSeed });
  const { retained, duplicates } = partitionSystemMonitors(
    jobs,
    skillCollectionReviewMonitorAgentId,
  );
  const runMutation = async (
    agentId: string,
    failureMessage: string,
    mutate: () => Promise<unknown>,
  ) => {
    // Fence after yielding: wrappers can stop process owners before their commit guard.
    await yieldToEventLoop();
    params.commitGuard?.();
    try {
      await mutate();
    } catch (error) {
      params.commitGuard?.();
      ok = false;
      params.logger.warn({ agentId, err: String(error) }, failureMessage);
    }
  };
  for (const { agentId, job } of duplicates) {
    await runMutation(agentId, "cron-skill-review: duplicate monitor cleanup failed", () =>
      params.cron.remove(job.id, {
        systemOwned: true,
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
      }),
    );
  }
  for (const spec of specs) {
    await runMutation(spec.agentId, "cron-skill-review: monitor convergence failed", () => {
      retained.delete(spec.agentId);
      return params.cron.add(spec.input, {
        enabledExplicit: true,
        systemOwned: true,
        matchesExisting: (job) => skillCollectionReviewMonitorAgentId(job) === spec.agentId,
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
      });
    });
  }

  for (const [agentId, job] of retained) {
    await runMutation(agentId, "cron-skill-review: stale monitor cleanup failed", () =>
      params.cron.remove(job.id, {
        systemOwned: true,
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
      }),
    );
  }
  return { ok };
}
