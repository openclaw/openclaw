import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import type { CronDeliveryPreview, CronJob } from "./types.js";

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
  if (!plan.requested && plan.mode === "none" && !params.job.delivery) {
    return { label: "not requested", detail: "not requested" };
  }
  if (plan.mode === "webhook") {
    const target = plan.to ? `webhook:${plan.to}` : "webhook";
    return { label: target, detail: plan.to ? "webhook" : "webhook target missing" };
  }

  const requestedChannel = plan.channel ?? "last";
  const agentId =
    params.job.agentId?.trim() || params.defaultAgentId || resolveDefaultAgentId(params.cfg);
  const resolved = await resolveDeliveryTarget(
    params.cfg,
    agentId,
    {
      channel: requestedChannel,
      to: plan.to,
      threadId: plan.threadId,
      accountId: plan.accountId,
      sessionKey: params.job.sessionKey,
    },
    { dryRun: true },
  );
  if (!resolved.ok) {
    return {
      label: `${plan.mode} -> ${formatTarget(requestedChannel, plan.to ?? null)}`,
      detail: formatDeliveryDetail({
        requestedChannel,
        resolved: false,
        sessionKey: params.job.sessionKey,
        error: resolved.error.message,
      }),
    };
  }
  return {
    label: `${plan.mode} -> ${formatTarget(resolved.channel, resolved.to)}`,
    detail: formatDeliveryDetail({
      requestedChannel,
      resolved: true,
      sessionKey: params.job.sessionKey,
    }),
  };
}

const CRON_DELIVERY_PREVIEW_CACHE_TTL_MS = 60_000;
const cronDeliveryPreviewCache = new Map<string, { value: CronDeliveryPreview; ts: number }>();

function buildCronDeliveryPreviewCacheKey(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  job: CronJob;
}): string {
  const plan = resolveCronDeliveryPlan(params.job);
  return JSON.stringify({
    agentId:
      params.job.agentId?.trim() ||
      params.defaultAgentId ||
      resolveDefaultAgentId(params.cfg) ||
      "",
    sessionKey: params.job.sessionKey ?? "",
    channel: plan.channel ?? "last",
    to: plan.to ?? "",
    threadId: plan.threadId ?? "",
    accountId: plan.accountId ?? "",
    mode: plan.mode ?? "announce",
    requested: plan.requested !== false,
  });
}

export async function resolveCronDeliveryPreviews(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  jobs: CronJob[];
}): Promise<Record<string, CronDeliveryPreview>> {
  const now = Date.now();
  const pendingByKey = new Map<string, Promise<CronDeliveryPreview>>();
  const entries = await Promise.all(
    params.jobs.map(async (job) => {
      const cacheKey = buildCronDeliveryPreviewCacheKey({
        cfg: params.cfg,
        defaultAgentId: params.defaultAgentId,
        job,
      });
      const cached = cronDeliveryPreviewCache.get(cacheKey);
      if (cached && now - cached.ts <= CRON_DELIVERY_PREVIEW_CACHE_TTL_MS) {
        return [job.id, cached.value] as const;
      }
      let pending = pendingByKey.get(cacheKey);
      if (!pending) {
        pending = resolveCronDeliveryPreview({
          cfg: params.cfg,
          defaultAgentId: params.defaultAgentId,
          job,
        }).then((value) => {
          cronDeliveryPreviewCache.set(cacheKey, { value, ts: Date.now() });
          return value;
        });
        pendingByKey.set(cacheKey, pending);
      }
      return [job.id, await pending] as const;
    }),
  );
  for (const [cacheKey, cached] of cronDeliveryPreviewCache) {
    if (now - cached.ts > CRON_DELIVERY_PREVIEW_CACHE_TTL_MS) {
      cronDeliveryPreviewCache.delete(cacheKey);
    }
  }
  return Object.fromEntries(entries);
}
