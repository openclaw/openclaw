import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { getPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { readChildRuntimeViability } from "../../infra/child-runtime-viability.js";
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import { readGatewayMaintenanceWork } from "../../infra/gateway-active-work.js";
import { getStatusSummary } from "../../status/summary.js";
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
  return (
    cached === undefined ||
    (["running", "connected", "lifecycle"] as const).some(
      (key) => runtime[key] !== undefined && cached[key] !== runtime[key],
    )
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
      return (
        Object.keys(cachedAccounts ?? {}).some(
          (accountId) => !Object.hasOwn(accounts, accountId),
        ) ||
        Object.entries(accounts).some(
          ([accountId, snapshot]) =>
            snapshot && cachedLifecycleDiffersFromRuntime(cachedAccounts?.[accountId], snapshot),
        )
      );
    }) ||
    // Hot-unloaded plugins vanish from both runtime maps before cached health expires.
    Object.keys(cached.channels).some(
      (channelId) =>
        !Object.hasOwn(runtime.channels, channelId) &&
        !Object.hasOwn(runtime.channelAccounts, channelId),
    )
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
    if (
      !wantsProbe &&
      cached &&
      !cachedDiffersFromRuntime &&
      !isFutureDateTimestampMs(cached.ts, { nowMs: now }) &&
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
      // Dead-letter counts are cheap live reads. Preserve the grouped pressure
      // aggregate for the cache interval so routine health RPCs do not amplify it.
      const deliveryQueues = await buildDeliveryQueueHealthSummary(
        _cachedDeliveryQueues?.ingressPressure ?? [],
      );
      const contextEngines = await buildContextEngineHealthSummary();
      // A reset sampler has no current window; never revive the cached reading.
      const eventLoop = getEventLoopHealth?.();
      respond(
        true,
        {
          ...cachedState,
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
        childRuntime: readChildRuntimeViability(),
      },
      undefined,
    );
  },
};
