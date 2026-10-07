import type { OpenClawConfig } from "../config/types.openclaw.js";
import { reconcileHeartbeatMonitorJobs } from "../cron/heartbeat-monitor.js";
import type { CronService } from "../cron/service.js";
import { resolveHeartbeatSchedulerSeedAsync } from "../infra/heartbeat-schedule.js";
import { reconcileSkillCollectionReviewJobs } from "./server-cron-skill-review-jobs.js";

/** Reconcile both monitor families against one configuration and device identity. */
export async function reconcileGatewayMonitorJobs(params: {
  cron: Pick<CronService, "add" | "list" | "remove">;
  cfg: OpenClawConfig;
  logger: { warn: (obj: unknown, msg?: string) => void };
  commitGuard: () => void;
}): Promise<{ ok: boolean }> {
  params.commitGuard();
  const schedulerSeed = await resolveHeartbeatSchedulerSeedAsync();
  params.commitGuard();
  let ok = true;
  for (const reconcile of [reconcileHeartbeatMonitorJobs, reconcileSkillCollectionReviewJobs]) {
    const result = await reconcile({ ...params, schedulerSeed });
    params.commitGuard();
    ok &&= result.ok;
  }
  return { ok };
}
