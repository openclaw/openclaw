import { setImmediate as nextTurn } from "node:timers/promises";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInternalHookSelection } from "../hooks/configured.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-gateway.types.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { getPluginRegistryVersion } from "../plugins/runtime-state.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServiceCronHost } from "../plugins/service-cron.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayControlUiRootLifecycle } from "./server-control-ui-root.js";
import type { GatewayClient, GatewayContextResolver } from "./server-methods/shared-types.js";
import type { GatewaySidecarStartupMode } from "./server-sidecar-startup-mode.js";
import { scheduleGatewayPrewarm } from "./server-startup-handler-prewarm.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";
import {
  createGatewayStartupOutcomeRecorder,
  formatGatewayStartupOutcomes,
} from "./server-startup-outcomes.js";
import { logGatewayReady, logGatewaySidecarsReady } from "./server-startup-readiness.js";
import {
  schedulePostReadySidecarTask,
  type GatewayPostReadySidecarHandle,
} from "./server-startup-sidecar-scheduler.js";
import { startGatewaySidecars } from "./server-startup-sidecars.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";
import { scheduleTranscriptsSidecar } from "./server-startup-transcripts.js";
import { createDeferredGatewayUpdateCheck } from "./server-startup-update-check.js";
import type { ReadinessChecker } from "./server/readiness.js";
import { beginMacOSSystemCaWarmupOnce } from "./system-ca-warmup.js";
type Awaitable<T> = T | Promise<T>;

/** Start work that depends on the HTTP server being attached and visible. */
export async function startGatewayPostAttachRuntime(params: {
  scheduler: GatewayScheduler;
  minimalTestGateway: boolean;
  updateCanary?: boolean;
  cfgAtStart: OpenClawConfig;
  getConfig: () => OpenClawConfig;
  port: number;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  isNixMode: boolean;
  startupStartedAt?: number;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  broadcast?: GatewayBroadcastFn;
  getClientConnIds: (filter?: (client: GatewayClient) => boolean) => ReadonlySet<string>;
  broadcastPluginEvent?: import("./server-broadcast-types.js").GatewayPluginEventBroadcastFn;
  controlUiRootLifecycle?: GatewayControlUiRootLifecycle;
  gatewayPluginConfigAtStart: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  pluginManifestRecords: readonly PluginManifestRecord[];
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  pluginRegistry: PluginRegistry;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  refreshChatMetadata?: () => Promise<void>;
  resolveGatewayContext: GatewayContextResolver;
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  unlockStartupMethods: () => void;
  loadStartupPlugins?: () => Awaitable<{
    pluginRegistry: PluginRegistry;
    gatewayMethods: string[];
    retireGatewayRuntimeBindings?: () => void;
  }>;
  onStartupPluginsLoading?: () => void;
  onStartupPluginsLoaded?: (result: {
    pluginRegistry: PluginRegistry;
    gatewayMethods: string[];
    retireGatewayRuntimeBindings?: () => void;
  }) => Awaitable<boolean>;
  getCurrentPluginRegistry?: () => PluginRegistry;
  shouldStartPluginServices?: () => boolean;
  getCronService?: () => PluginServiceCronHost | null | undefined;
  onChannelsStarted?: () => void;
  onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
  onPostReadySidecars: (...sidecars: GatewayPostReadySidecarHandle[]) => void;
  onGatewayLifetimeSidecars: (...sidecars: GatewayPostReadySidecarHandle[]) => void;
  unregisterConnectionDependentSidecar: (sidecar: GatewayPostReadySidecarHandle) => void;
  trackStartupWork: <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  startWorkerEnvironmentRuntime?: () => Awaitable<GatewayPostReadySidecarHandle | null>;
  onSidecarsReady?: () => void;
  getReadiness: ReadinessChecker;
  isClosing?: () => boolean;
  startupTrace?: GatewayStartupTrace;
  sidecarStartup?: GatewaySidecarStartupMode;
  waitForPostReadyWork?: () => Promise<void>;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
}) {
  const restartSentinelContext = captureDeliveryQueueStateContext();
  // The CLI's hidden capability flag supplies this typed internal handoff.
  // Rehearsal loads plugins without resuming copied jobs, services, or notices.
  const candidateCanary = params.updateCanary === true;
  const controlUiRootLifecycle = params.controlUiRootLifecycle;
  const controlUiAssetsSidecar =
    !params.minimalTestGateway && controlUiRootLifecycle
      ? schedulePostReadySidecarTask({
          name: "sidecars.control-ui-assets",
          startupTrace: params.startupTrace,
          log: params.log,
          shouldRun: () => params.isClosing?.() !== true,
          run: controlUiRootLifecycle.start,
          stop: controlUiRootLifecycle.stop,
        })
      : undefined;
  if (controlUiAssetsSidecar) {
    // Publish before the first await: slow CA/plugin startup must not strand
    // the dashboard or hide its running builder from Gateway shutdown.
    params.onGatewayLifetimeSidecars(controlUiAssetsSidecar);
  }

  if (!params.minimalTestGateway) {
    // The HTTP server is already attached, so keep health probes responsive while the worker
    // resolves Node's effective default CA set before any plugin or worker provider can use TLS.
    await measureStartup(params.startupTrace, "post-attach.system-ca", () =>
      beginMacOSSystemCaWarmupOnce({ log: params.log }),
    );
  }

  let pluginRegistry = params.pluginRegistry;
  const loadStartupPluginsIfNeeded = async () => {
    if (params.minimalTestGateway || !params.loadStartupPlugins) {
      return;
    }
    params.onStartupPluginsLoading?.();
    // Capture retirement before starting work that can finish after shutdown begins.
    const { disposePluginRegistryInstances } = await import("../plugins/runtime.js");
    const loaded = await measureStartup(params.startupTrace, "plugins.runtime-post-bind", () =>
      params.loadStartupPlugins!(),
    );
    // Shutdown owns attached registries; this startup producer retires discarded results.
    const disposeUnattached = async () => {
      const current = params.getCurrentPluginRegistry?.() ?? pluginRegistry;
      if (loaded.pluginRegistry !== current) {
        loaded.retireGatewayRuntimeBindings?.();
        await disposePluginRegistryInstances(loaded.pluginRegistry, current);
      }
      pluginRegistry = current;
    };
    if (params.isClosing?.()) {
      return await disposeUnattached();
    }
    let published: boolean | undefined;
    try {
      published = await measureStartup(params.startupTrace, "plugins.runtime-attach", () =>
        params.onStartupPluginsLoaded?.(loaded),
      );
    } catch (error) {
      await disposeUnattached().catch((cleanupError: unknown) => {
        throw new AggregateError(
          [error, cleanupError],
          "Startup plugin attachment cleanup failed",
          { cause: error },
        );
      });
      throw error;
    }
    if (published === false) {
      return await disposeUnattached();
    }
    pluginRegistry = loaded.pluginRegistry;
    params.broadcast?.(
      "plugins.changed",
      { generation: getPluginRegistryVersion(pluginRegistry) },
      { dropIfSlow: true },
    );
    params.startupTrace?.detail("plugins.runtime-post-bind", [
      [
        "loadedPluginCount",
        pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
      ],
      ["gatewayMethodCount", loaded.gatewayMethods.length],
    ]);
  };
  let startupLogPromise: Promise<void> | undefined;
  const startupLogSettled = createDeferredCore();
  // Tailscale and sidecar work can delay the public readiness handle past log failure.
  void startupLogSettled.promise.catch(() => {});
  const assignStartupLogOwner = (owner: Promise<void>) => {
    if (params.sidecarStartup !== "defer") {
      return;
    }
    void owner.then(startupLogSettled.resolve, startupLogSettled.reject);
  };
  const startStartupLog = () => {
    if (startupLogPromise) {
      return startupLogPromise;
    }
    // Sidecar failure can settle public readiness before this producer finishes.
    startupLogPromise = params.trackStartupWork(() =>
      measureStartup(params.startupTrace, "post-attach.log", async () =>
        (await import("./server-startup-log.js")).logGatewayStartup({
          cfg: params.cfgAtStart,
          activationSourceConfig: params.activationSourceConfig,
          env: process.env,
          manifestRecords: params.pluginManifestRecords,
          ...(params.ambientEnvTriggers ? { ambientEnvTriggers: params.ambientEnvTriggers } : {}),
          loadedPluginIds: pluginRegistry.plugins
            .filter((plugin) => plugin.status === "loaded")
            .map((plugin) => plugin.id),
          log: params.log,
          isNixMode: params.isNixMode,
          startupStartedAt: params.startupStartedAt,
        }),
      ),
    );
    void startupLogPromise.catch(() => {});
    assignStartupLogOwner(startupLogPromise);
    return startupLogPromise;
  };
  const skipStartupLog = () => assignStartupLogOwner(Promise.resolve());

  const updateCheck = createDeferredGatewayUpdateCheck({
    scheduler: params.scheduler,
    startupTrace: params.startupTrace,
    getConfig: params.getConfig,
    getPluginRegistry: () => params.getCurrentPluginRegistry?.() ?? pluginRegistry,
    log: params.log,
    isNixMode: params.isNixMode,
    broadcastToConnIds: params.broadcastToConnIds,
    getClientConnIds: params.getClientConnIds,
    waitForPostReadyWork: params.waitForPostReadyWork,
    isClosing: params.isClosing,
    activeWorkInspectors: params.activeWorkInspectors,
  });
  // Startup failure can precede publication of the post-attach return handle.
  params.onGatewayLifetimeSidecars(updateCheck);

  const startSidecars = () =>
    params.minimalTestGateway
      ? startStartupLog().then(() => {
          if (!candidateCanary && !params.isClosing?.()) {
            params.onChannelsStarted?.();
          }
          return pluginRegistry;
        })
      : nextTurn().then(async () => {
          if (params.isClosing?.()) {
            skipStartupLog();
            return pluginRegistry;
          }
          await loadStartupPluginsIfNeeded();
          if (params.isClosing?.()) {
            skipStartupLog();
            return pluginRegistry;
          }
          const startupLog = startStartupLog();
          if (candidateCanary) {
            await startupLog;
            // Retain attributed plugin failures in the published registry for health reporting.
            if (
              pluginRegistry.diagnostics.some(
                (diagnostic) => diagnostic.level === "error" && !diagnostic.pluginId,
              )
            ) {
              throw new Error("Candidate plugin registry reported an unattributed error");
            }
            params.unlockStartupMethods();
            params.onSidecarsReady?.();
            logGatewayReady(params, "candidate gateway ready; autonomous sidecars suppressed");
            return pluginRegistry;
          }
          const internalHookSelection = await resolveInternalHookSelection(
            params.gatewayPluginConfigAtStart,
          );
          const startupOutcomes = createGatewayStartupOutcomeRecorder({
            cfg: params.gatewayPluginConfigAtStart,
            internalHooksConfigured: internalHookSelection.configured,
            gatewayStartHooks: pluginRegistry.typedHooks.some(
              (hook) => hook.hookName === "gateway_start",
            ),
          });
          const workerEnvironmentSidecar = params.isClosing?.()
            ? null
            : ((await measureStartup(params.startupTrace, "sidecars.worker-environments", () =>
                params.startWorkerEnvironmentRuntime?.(),
              )) ?? null);
          if (params.isClosing?.()) {
            return pluginRegistry;
          }
          params.log.info("starting channels and sidecars...");
          const loaderStatsBefore = getPluginModuleLoaderStats();
          const postReadySidecarCount = await (async () => {
            try {
              return await measureStartup(params.startupTrace, "sidecars.total", () =>
                startGatewaySidecars({
                  scheduler: params.scheduler,
                  restartSentinelContext,
                  cfg: params.gatewayPluginConfigAtStart,
                  getModelRuntimeConfig: params.getConfig,
                  ...(params.pluginMetadataSnapshot
                    ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
                    : {}),
                  pluginRegistry,
                  defaultWorkspaceDir: params.defaultWorkspaceDir,
                  deps: params.deps,
                  getCronService: params.getCronService,
                  startChannels: params.startChannels,
                  trackStartupWork: params.trackStartupWork,
                  shouldStartChannels: () => params.isClosing?.() !== true,
                  refreshChatMetadata: params.refreshChatMetadata,
                  log: params.log,
                  logHooks: params.logHooks,
                  logChannels: params.logChannels,
                  startupTrace: params.startupTrace,
                  onPluginServices: params.onPluginServices,
                  onPostReadySidecars: params.onPostReadySidecars,
                  shouldCreatePostReadySidecars: () => params.isClosing?.() !== true,
                  shouldStartPluginServices: () =>
                    params.isClosing?.() !== true && params.shouldStartPluginServices?.() !== false,
                  broadcastPluginEvent: params.broadcastPluginEvent,
                  startupOutcomes,
                  internalHookSelection,
                  waitForPostReadyWork: params.waitForPostReadyWork,
                }),
              );
            } catch (error) {
              try {
                await workerEnvironmentSidecar?.stop();
                if (workerEnvironmentSidecar) {
                  params.unregisterConnectionDependentSidecar(workerEnvironmentSidecar);
                }
              } catch (cleanupError) {
                params.log.warn(
                  `worker environment cleanup after sidecar startup failure failed: ${String(cleanupError)}`,
                );
              }
              throw error;
            }
          })();
          if (params.isClosing?.()) {
            return pluginRegistry;
          }
          const loaderStatsAfter = getPluginModuleLoaderStats();
          params.startupTrace?.detail("sidecars.plugin-loader", [
            ["callsCount", loaderStatsAfter.calls - loaderStatsBefore.calls],
            ["nativeHitsCount", loaderStatsAfter.nativeHits - loaderStatsBefore.nativeHits],
            ["nativeMissesCount", loaderStatsAfter.nativeMisses - loaderStatsBefore.nativeMisses],
            [
              "sourceTransformForcedCount",
              loaderStatsAfter.sourceTransformForced - loaderStatsBefore.sourceTransformForced,
            ],
            [
              "sourceTransformFallbacksCount",
              loaderStatsAfter.sourceTransformFallbacks -
                loaderStatsBefore.sourceTransformFallbacks,
            ],
          ]);
          await startupLog;
          if (params.isClosing?.()) {
            return pluginRegistry;
          }
          const newGatewayLifetimeSidecars = scheduleGatewayPrewarm(params);
          newGatewayLifetimeSidecars.push(
            scheduleTranscriptsSidecar({
              cfg: params.gatewayPluginConfigAtStart,
              getConfig: params.getConfig,
              getPluginRegistry: () => params.getCurrentPluginRegistry?.() ?? pluginRegistry,
              lifetimeSignal: getGatewayContextLifetime(params.resolveGatewayContext).signal,
              startupTrace: params.startupTrace,
              log: params.log,
              waitForPostReadyWork: params.waitForPostReadyWork,
              shouldRun: () => params.isClosing?.() !== true,
            }),
          );
          params.onGatewayLifetimeSidecars(...newGatewayLifetimeSidecars);
          params.log.info(formatGatewayStartupOutcomes(startupOutcomes.snapshot()));
          logGatewaySidecarsReady({
            log: params.log,
            getReadiness: params.getReadiness,
            startupTrace: params.startupTrace,
            loadedPluginCount: pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded")
              .length,
            postReadySidecarCount:
              postReadySidecarCount +
              newGatewayLifetimeSidecars.length +
              (controlUiAssetsSidecar ? 1 : 0),
          });
          return pluginRegistry;
        });
  // Track original startup producers and their post-ready continuation so close
  // retains dependency loads and hooks even when readiness has already settled.
  const sidecarsPromise = params.trackStartupWork(startSidecars);
  void params
    .trackStartupWork(async (signal) => {
      const sidecarRegistry = await sidecarsPromise;
      if (params.minimalTestGateway || candidateCanary) {
        return;
      }
      if (signal.aborted || params.isClosing?.()) {
        return;
      }
      params.onSidecarsReady?.();
      await runGatewayStartupObservers({
        registry: sidecarRegistry,
        signal,
        resolveGatewayContext: params.resolveGatewayContext,
        loadSubagentRegistryActivation: async () =>
          (await import("../agents/subagents/registry/subagent-registry.js"))
            .activateSubagentRegistry,
        port: params.port,
        config: params.gatewayPluginConfigAtStart,
        workspaceDir: params.defaultWorkspaceDir,
        getCron: () =>
          (params.getCronService?.() ?? params.deps.cron) as
            | PluginHookGatewayCronService
            | undefined,
        isClosing: params.isClosing,
        unlockStartupMethods: () => {
          params.onChannelsStarted?.();
          params.unlockStartupMethods();
        },
        startupTrace: params.startupTrace,
        log: params.log,
        logHooks: params.logHooks,
        createHookRunner: async (...args) =>
          (await import("../plugins/hooks.js")).createHookRunner(...args),
        refreshLatestUpdateRestartSentinel: async () =>
          (await import("./server-update-sentinel.js")).prepareLatestUpdateRestartSentinel(
            restartSentinelContext.workerContext.environment,
          ),
      });
    })
    .catch((err: unknown) => {
      params.log.warn(`gateway sidecars failed to start: ${String(err)}`);
    });

  if (params.sidecarStartup !== "defer") {
    await sidecarsPromise;
  }
  if (!params.minimalTestGateway && !candidateCanary) {
    updateCheck.start();
  }
  const startupSettled =
    params.sidecarStartup === "defer"
      ? Promise.all([sidecarsPromise, startupLogSettled.promise]).then(() => undefined)
      : Promise.resolve();
  // Direct callers may ignore this handle; only the managed run loop observes it.
  // Pre-handle so an ignored deferred sidecar failure never becomes an unhandled rejection.
  void startupSettled.catch(() => {});

  return {
    stopGatewayUpdateCheck: updateCheck.stop,
    startupSettled,
  };
}
