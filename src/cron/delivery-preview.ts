import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import { resolveCronDeliverySessionKey } from "./session-target.js";
import type { CronDeliveryPreview, CronJob } from "./types.js";

const CRON_DELIVERY_PREVIEWS_CACHE_TTL_MS = 1_000;

type CronDeliveryPreviewsCacheEntry = {
  expiresAt: number;
  previews: Record<string, CronDeliveryPreview>;
};

const cronDeliveryPreviewsCache = new Map<string, CronDeliveryPreviewsCacheEntry>();
const cronDeliveryPreviewsInFlight = new Map<
  string,
  Promise<Record<string, CronDeliveryPreview>>
>();

function getCronDeliveryPreviewsCacheKey(params: {
  defaultAgentId?: string;
  jobs: CronJob[];
}): string {
  return JSON.stringify({
    defaultAgentId: params.defaultAgentId ?? null,
    jobs: params.jobs.map((job) => ({
      id: job.id,
      updatedAtMs: job.updatedAtMs,
      agentId: job.agentId,
      sessionTarget: job.sessionTarget,
      sessionKey: job.sessionKey,
      delivery: job.delivery,
    })),
  });
}

export function clearCronDeliveryPreviewsCache(): void {
  cronDeliveryPreviewsCache.clear();
  cronDeliveryPreviewsInFlight.clear();
}

function formatTarget(channel?: string, to?: string | null): string {
  if (!channel) {
    return "last";
  }
  if (to) {
    return `${channel}:${to}`;
  }
  return channel;
}

function formatDeliveryDetail(params: {
  requestedChannel?: string;
  resolved: boolean;
  sessionKey?: string;
  error?: string;
}): string {
  if (params.requestedChannel === "last" || !params.requestedChannel) {
    if (!params.resolved) {
      return params.error
        ? `last -> no route, will fail-closed: ${params.error}`
        : "last -> no route, will fail-closed";
    }
    return params.sessionKey
      ? `resolved from last, session ${params.sessionKey}`
      : "resolved from last, main session";
  }
  return params.resolved ? "explicit" : (params.error ?? "unresolved");
}

export async function resolveCronDeliveryPreview(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  job: CronJob;
}): Promise<CronDeliveryPreview> {
  const plan = resolveCronDeliveryPlan(params.job);
  if (plan.mode === "none") {
    return { label: "not requested", detail: "not requested" };
  }
  if (plan.mode === "webhook") {
    const target = plan.to ? `webhook:${plan.to}` : "webhook";
    return { label: target, detail: plan.to ? "webhook" : "webhook target missing" };
  }

  const requestedChannel = plan.channel ?? "last";
  const agentId =
    params.job.agentId?.trim() || params.defaultAgentId || resolveDefaultAgentId(params.cfg);
  const deliverySessionKey = resolveCronDeliverySessionKey(params.job);
  const resolved = await resolveDeliveryTarget(
    params.cfg,
    agentId,
    {
      channel: requestedChannel,
      to: plan.to,
      threadId: plan.threadId,
      accountId: plan.accountId,
      sessionKey: deliverySessionKey,
    },
    { dryRun: true },
  );
  if (!resolved.ok) {
    return {
      label: `${plan.mode} -> ${formatTarget(requestedChannel, plan.to ?? null)}`,
      detail: formatDeliveryDetail({
        requestedChannel,
        resolved: false,
        sessionKey: deliverySessionKey,
        error: resolved.error.message,
      }),
    };
  }
  return {
    label: `${plan.mode} -> ${formatTarget(resolved.channel, resolved.to)}`,
    detail: formatDeliveryDetail({
      requestedChannel,
      resolved: true,
      sessionKey: deliverySessionKey,
    }),
  };
}

export async function resolveCronDeliveryPreviews(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  jobs: CronJob[];
}): Promise<Record<string, CronDeliveryPreview>> {
  const cacheKey = getCronDeliveryPreviewsCacheKey({
    defaultAgentId: params.defaultAgentId,
    jobs: params.jobs,
  });
  const now = Date.now();
  const cached = cronDeliveryPreviewsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.previews;
  }
  const existing = cronDeliveryPreviewsInFlight.get(cacheKey);
  if (existing) {
    return existing;
  }
  const promise = Promise.all(
    params.jobs.map(
      async (job) =>
        [
          job.id,
          await resolveCronDeliveryPreview({
            cfg: params.cfg,
            defaultAgentId: params.defaultAgentId,
            job,
          }),
        ] as const,
    ),
  )
    .then((entries) => {
      const previews = Object.fromEntries(entries);
      cronDeliveryPreviewsCache.set(cacheKey, {
        expiresAt: Date.now() + CRON_DELIVERY_PREVIEWS_CACHE_TTL_MS,
        previews,
      });
      return previews;
    })
    .finally(() => {
      cronDeliveryPreviewsInFlight.delete(cacheKey);
    });
  cronDeliveryPreviewsInFlight.set(cacheKey, promise);
  return promise;
}
