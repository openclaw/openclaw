// Health gateway methods return cached or refreshed status summaries while
// detecting stale channel runtime state against live gateway snapshots.
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { getPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import { readGatewayMaintenanceWork } from "../../infra/gateway-active-work.js";
import { getStatusSummary } from "../../status/summary.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import { buildContextEngineHealthSummary } from "../health/context-engine.js";
import { buildDeliveryQueueHealthSummary } from "../health/delivery-queue.js";
import type { ChannelHealthSummary, HealthSummary } from "../health/types.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import type { GatewayShutdownStatus } from "../server-public.js";
import { shouldScheduleBackgroundHealthRefresh } from "../server/health-refresh-admission.js";
import { readGatewayProcessVitals, readGatewayWorkerPoolFacts } from "../server/process-vitals.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";

function cachedLifecycleDiffersFromRuntime(params: {
  cachedAccount: ChannelHealthSummary | undefined;
  runtimeSnapshot: ChannelAccountSnapshot;
}): boolean {
  for (const key of ["running", "connected", "lifecycle"] as const) {
    const runtimeValue = params.runtimeSnapshot[key];
    if (runtimeValue !== undefined && params.cachedAccount?.[key] !== runtimeValue) {
      return true;
    }
  }
  return params.cachedAccount === undefined;
}

/** Checks whether cached channel health is stale against the live runtime snapshot. */
function cachedHealthDiffersFromRuntime(
  cached: HealthSummary,
  runtime: ChannelRuntimeSnapshot,
): boolean {
  for (const [channelId, runtimeSnapshot] of Object.entries(runtime.channels)) {
    if (!runtimeSnapshot) {
      continue;
    }
    const cachedChannel = cached.channels[channelId];
    if (
      cachedLifecycleDiffersFromRuntime({
        cachedAccount: cachedChannel,
        runtimeSnapshot,
      })
    ) {
      return true;
    }
  }

  for (const [channelId, accounts] of Object.entries(runtime.channelAccounts)) {
    if (!accounts) {
      continue;
    }
    const cachedChannel = cached.channels[channelId];
    const cachedAccounts = cachedChannel?.accounts;
    if (
      Object.keys(cachedAccounts ?? {}).some((accountId) => !Object.hasOwn(accounts, accountId))
    ) {
      return true;
    }
    for (const [accountId, runtimeSnapshot] of Object.entries(accounts)) {
      if (!runtimeSnapshot) {
        continue;
      }
      if (
        cachedLifecycleDiffersFromRuntime({
          cachedAccount: cachedAccounts?.[accountId],
          runtimeSnapshot,
        })
      ) {
        return true;
      }
    }
  }

  // Hot-unloaded plugins vanish from both runtime maps before cached health expires.
  return Object.keys(cached.channels).some(
    (channelId) =>
      !Object.hasOwn(runtime.channels, channelId) &&
      !Object.hasOwn(runtime.channelAccounts, channelId),
  );
}

/** Merges cheap live runtime facts into a cached health summary before responding. */
async function mergeCachedHealthRuntimeState(params: {
  cached: HealthSummary;
  getEventLoopHealth?: () => HealthSummary["eventLoop"];
  configReloadHotReloadStatus?: GatewayHotReloadStatus;
}): Promise<HealthSummary> {
  const {
    contextEngines: _cachedContextEngines,
    deliveryQueues: _cachedDeliveryQueues,
    eventLoop: _cachedEventLoop,
    ...cached
  } = params.cached;
  // Dead-letter counts are cheap live reads. Preserve the grouped pressure
  // aggregate for the cache interval so routine health RPCs do not amplify it.
  const deliveryQueues = await buildDeliveryQueueHealthSummary(
    _cachedDeliveryQueues?.ingressPressure ?? [],
  );
  const contextEngines = buildContextEngineHealthSummary();
  // A reset sampler has no current window; never revive the cached reading.
  const eventLoop = params.getEventLoopHealth?.();
  return {
    ...cached,
    modelRuntime: getPreparedModelRuntimeStartupStatus(),
    ...(eventLoop ? { eventLoop } : {}),
    ...(contextEngines ? { contextEngines } : {}),
    ...(deliveryQueues ? { deliveryQueues } : {}),
    ...(params.configReloadHotReloadStatus
      ? { configReload: { hotReloadStatus: params.configReloadHotReloadStatus } }
      : {}),
  };
}

/** Gateway handlers for health snapshots and status summaries. */
export const healthHandlers: GatewayRequestHandlers = {
  health: async ({ respond, context, params, client }) => {
    const { getHealthCache, refreshHealthSnapshot, logHealth } = context;
    const wantsProbe = params?.probe === true;
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const includeSensitive = scopes.includes(ADMIN_SCOPE);
    const now = Date.now();
    const cached = getHealthCache();
    let cachedDiffersFromRuntime = false;
    if (!wantsProbe && cached) {
      try {
        cachedDiffersFromRuntime = cachedHealthDiffersFromRuntime(
          cached,
          context.getRuntimeSnapshot(),
        );
      } catch {
        cachedDiffersFromRuntime = true;
      }
    }
    if (
      !wantsProbe &&
      cached &&
      !cachedDiffersFromRuntime &&
      !isFutureDateTimestampMs(cached.ts, { nowMs: now }) &&
      now - cached.ts < HEALTH_REFRESH_INTERVAL_MS
    ) {
      respond(
        true,
        await mergeCachedHealthRuntimeState({
          cached,
          getEventLoopHealth: context.getEventLoopHealth,
          configReloadHotReloadStatus: context.getConfigReloaderHotReloadStatus?.(),
        }),
        undefined,
        { cached: true },
      );
      if (shouldScheduleBackgroundHealthRefresh(refreshHealthSnapshot, now)) {
        void refreshHealthSnapshot({ probe: false, includeSensitive }).catch((err: unknown) =>
          logHealth.error(`background health refresh failed: ${formatError(err)}`),
        );
      }
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const snap = await refreshHealthSnapshot({ probe: wantsProbe, includeSensitive });
      respond(true, { ...snap, modelRuntime: getPreparedModelRuntimeStartupStatus() }, undefined);
    });
  },
  status: async ({ respond, client, params, context }) => {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const hostDesktopStatus = await context.hostDesktopService?.status();
    const status = await getStatusSummary({
      includeSensitive: scopes.includes(ADMIN_SCOPE),
      includeChannelSummary: params.includeChannelSummary !== false,
      includeCliProjection: params.includeCliProjection === true,
      sessionRowProjection: getSessionRowProjection(context),
      ...(hostDesktopStatus ? { hostDesktopStatus } : {}),
    });
    const workerPools = await readGatewayWorkerPoolFacts();
    const shutdownBudget = context.hostLifecycle?.getShutdownBudget?.();
    const activeWork = shutdownBudget
      ? readGatewayMaintenanceWork(createGatewayServerActiveWorkInspectors(context))
      : undefined;
    const shutdownStatus: GatewayShutdownStatus | undefined =
      shutdownBudget && activeWork
        ? {
            ...shutdownBudget,
            activeWork: activeWork.counts,
            writeCustody: activeWork.writeCustody,
          }
        : undefined;
    respond(
      true,
      {
        ...status,
        modelRuntime: getPreparedModelRuntimeStartupStatus(),
        ...readGatewayProcessVitals(context.getEventLoopHealth),
        workerPools,
        pid: process.pid,
        shutdownBudget: shutdownStatus,
      },
      undefined,
    );
  },
};
