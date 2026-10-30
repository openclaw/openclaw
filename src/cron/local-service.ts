import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import { DEFAULT_CRON_ENABLED } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { getChildLogger, getResolvedLoggerSettings, toPinoLikeLogger } from "../logging/logger.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  disableCronJobsBoundToSessions,
  type CronSessionCleanupIdentity,
  type DisableCronJobsBoundToSessionsResult,
} from "./job-session-bindings.js";
import { CronService } from "./service.js";
import { resolveCronJobsStorePathAsync } from "./store.js";

async function createLocalCronService(getRuntimeConfig: () => OpenClawConfig) {
  const cfg = getRuntimeConfig();
  const storePath = await resolveCronJobsStorePathAsync();
  const scheduler = new GatewayScheduler();
  const service = new CronService({
    scheduler,
    storePath,
    cronEnabled: cfg.cron?.enabled ?? DEFAULT_CRON_ENABLED,
    cronConfig: cfg.cron,
    log: toPinoLikeLogger(
      getChildLogger({ module: "cron", storeKey: storePath }),
      getResolvedLoggerSettings().level,
    ),
    defaultAgentId: tryResolveAmbientOwnerAgentId(cfg),
    resolveDefaultAgentId: () => tryResolveAmbientOwnerAgentId(getRuntimeConfig()),
    isAgentAvailable: (id, facts) =>
      !facts.deletionBlocked &&
      listAgentIds(getRuntimeConfig()).some(
        (configuredId) => normalizeAgentId(configuredId) === id,
      ),
    enqueueSystemEvent: () => false,
    runIsolatedAgentJob: async () => {
      throw new Error("Cron execution is unavailable in local service context.");
    },
  });
  return { scheduler, service };
}

export async function withLocalAgentCronJobsRemoved<T>(
  agentId: string,
  getRuntimeConfig: () => OpenClawConfig,
  commit: () => Promise<T>,
): Promise<T> {
  const { scheduler, service } = await createLocalCronService(getRuntimeConfig);
  try {
    return await service.removeAgentJobsTransactional(agentId, commit);
  } finally {
    service.stop();
    await scheduler.stop();
  }
}

/** Disables jobs for a caller that already owns local OpenClaw state. */
export async function disableLocalCronJobsBoundToSessions(params: {
  cfg: OpenClawConfig;
  sessions: readonly CronSessionCleanupIdentity[];
}): Promise<DisableCronJobsBoundToSessionsResult> {
  const { scheduler, service } = await createLocalCronService(() => params.cfg);
  try {
    return await disableCronJobsBoundToSessions({
      cron: service,
      cfg: params.cfg,
      sessions: params.sessions,
    });
  } finally {
    service.stop();
    await scheduler.stop();
  }
}
