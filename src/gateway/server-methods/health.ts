import { getPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { readChildRuntimeViability } from "../../infra/child-runtime-viability.js";
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import { readGatewayMaintenanceWork } from "../../infra/gateway-active-work.js";
import { prepareStatusSummary } from "../../status/summary.js";
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

function cachedLifecycleDiffersFromRuntime(
  cached: ChannelHealthSummary | undefined,
  runtime: ChannelAccountSnapshot,
): boolean {
  return (["running", "connected", "lifecycle"] as const).some(
    (key) => runtime[key] !== undefined && cached?.[key] !== runtime[key],
  );
}

function cachedHealthDiffersFromRuntime(
  cached: HealthSummary,
  runtime: ChannelRuntimeSnapshot,
): boolean {
  return (
    Object.entries(runtime.channels).some(
      ([channelId, snapshot]) =>
        snapshot && cachedLifecycleDiffersFromRuntime(cached.channels[channelId], snapshot),
    ) ||
    Object.entries(runtime.channelAccounts).some(([channelId, accounts]) => {
      if (!accounts) {
        return false;
      }
      const cachedAccounts = cached.channels[channelId]?.accounts;
      return Object.entries(accounts).some(
        ([accountId, snapshot]) =>
          snapshot && cachedLifecycleDiffersFromRuntime(cachedAccounts?.[accountId], snapshot),
      );
    })
  );
}

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
    // Topology changes and clock rollback use ordinary cache expiry or an explicit probe.
    if (
      !wantsProbe &&
      cached &&
      !cachedDiffersFromRuntime &&
      now - cached.ts < HEALTH_REFRESH_INTERVAL_MS
    ) {
      const getEventLoopHealth = context.getEventLoopHealth;
      const configReloadHotReloadStatus = context.getConfigReloaderHotReloadStatus?.();
      const {
        contextEngines: _cachedContextEngines,
        deliveryQueues: _cachedDeliveryQueues,
        eventLoop: _cachedEventLoop,
        ...cachedState
      } = cached;
      // The queue owner reuses health facts until a write receipt or claim expiry invalidates them.
      const deliveryQueues = await buildDeliveryQueueHealthSummary();
      const contextEngines = await buildContextEngineHealthSummary();
      // A reset sampler has no current window; never revive the cached reading.
      const eventLoop = getEventLoopHealth?.();
      respond(
        true,
        {
          ...cachedState,
          // Readiness follows live admission, never the health snapshot's refresh cadence.
          coreReady: context.getReadiness?.().coreReady,
          modelRuntime: getPreparedModelRuntimeStartupStatus(),
          ...(eventLoop ? { eventLoop } : {}),
          ...(contextEngines ? { contextEngines } : {}),
          ...(deliveryQueues ? { deliveryQueues } : {}),
          ...(configReloadHotReloadStatus
            ? { configReload: { hotReloadStatus: configReloadHotReloadStatus } }
            : {}),
          // Live check. The cache must not keep a path that disappeared after it was stored.
          childRuntime: readChildRuntimeViability(),
        },
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
      respond(
        true,
        {
          ...snap,
          coreReady: context.getReadiness?.().coreReady,
          modelRuntime: getPreparedModelRuntimeStartupStatus(),
          childRuntime: readChildRuntimeViability(),
        },
        undefined,
      );
    });
  },
  status: async ({ respond, client, params, context }) => {
    const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const hostDesktopStatus = await context.hostDesktopService?.status();
    const prepared = await prepareStatusSummary({
      includeSensitive: scopes.includes(ADMIN_SCOPE),
      includeChannelSummary: params.includeChannelSummary !== false,
      includeCliProjection: params.includeCliProjection === true,
      sessionRowProjection: getSessionRowProjection(context),
      ...(hostDesktopStatus ? { hostDesktopStatus } : {}),
    });
    const workerPools = await readGatewayWorkerPoolFacts();
    const status = prepared.publish().summary;
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
        childRuntime: readChildRuntimeViability(),
        pluginReload: context.getPluginReloadStatus?.(),
      },
      undefined,
    );
  },
};
