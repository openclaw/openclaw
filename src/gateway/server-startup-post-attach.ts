import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { loadGetReplyFromConfigRuntime } from "../auto-reply/reply/dispatch-from-config.runtime-loaders.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInternalHookSelection } from "../hooks/configured.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import { hasRestartSentinel } from "../infra/restart-sentinel.js";
import type { createGatewayUpdateCheck } from "../infra/update-startup.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-gateway.types.js";
import type { createHookRunner } from "../plugins/hooks.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  getGatewayContextLifetime,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServiceCronHost } from "../plugins/service-cron.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayControlUiRootLifecycle } from "./server-control-ui-root.js";
import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";
import type { GatewayClient, GatewayContextResolver } from "./server-methods/shared-types.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";
import type { refreshLatestUpdateRestartSentinel } from "./server-restart-sentinel.js";
import type { GatewaySidecarStartupMode } from "./server-sidecar-startup-mode.js";
import { scheduleContextCachePrewarm } from "./server-startup-context-cache-prewarm.js";
import { scheduleGatewayHandlerPrewarm } from "./server-startup-handler-prewarm.js";
import type { logGatewayStartup } from "./server-startup-log.js";
import {
  hydrateConfiguredExternalCliAuth,
  publishConfiguredModelRuntimeSnapshots,
} from "./server-startup-model-runtime.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";
import {
  createGatewayStartupOutcomeRecorder,
  formatGatewayStartupOutcomes,
  type GatewayStartupOutcomeRecorder,
} from "./server-startup-outcomes.js";
import { logGatewayReady, logGatewaySidecarsReady } from "./server-startup-readiness.js";
import {
  refreshLatestUpdateRestartSentinelIfPresent,
  scheduleRestartSentinelWakeAfterReady,
} from "./server-startup-restart-sentinel.js";
import {
  scheduleGatewayGenerationTimer,
  schedulePostReadySidecarTask,
  type GatewayPostReadySidecarHandle,
} from "./server-startup-sidecar-scheduler.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";
import { scheduleTranscriptsSidecar } from "./server-startup-transcripts.js";
import { createDeferredGatewayUpdateCheck } from "./server-startup-update-check.js";
import type { ReadinessChecker } from "./server/readiness.js";
import {
  beginMacOSSystemCaWarmupOnce,
  type warmMacOSSystemCaOffMainThread,
} from "./system-ca-warmup.js";
const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;
type Awaitable<T> = T | Promise<T>;

const loadMainSessionRestartRecoveryModule = createLazyRuntimeModule(
  () => import("../agents/main-session-recovery/main-session-restart-recovery.js"),
);
// Startup only needs orphan marking; keep resume and delivery runtime out of the pre-channel path.
const loadMainSessionRestartRecoveryMarkingModule = createLazyRuntimeModule(
  () => import("../agents/main-session-recovery/main-session-restart-recovery-marking.js"),
);

const loadAgentDefaultsModule = createLazyRuntimeModule(() => import("../agents/defaults.js"));

const loadAgentModelSelectionModule = createLazyRuntimeModule(
  () => import("../agents/model-selection.js"),
);

const loadInternalHooksModule = createLazyRuntimeModule(() => import("../hooks/internal-hooks.js"));

function shouldCheckRestartSentinel(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VITEST && env.NODE_ENV !== "test";
}

function hasGatewayStartHooks(pluginRegistry: ReturnType<typeof loadOpenClawPlugins>): boolean {
  return pluginRegistry.typedHooks.some((hook) => hook.hookName === "gateway_start");
}

async function hasGatewayStartupInternalHookListeners(): Promise<boolean> {
  const { hasInternalHookListeners } = await loadInternalHooksModule();
  return hasInternalHookListeners("gateway", "startup");
}

async function waitForAcpRuntimeBackendReady(params: {
  backendId?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const { getAcpRuntimeBackend } = await import("../acp/runtime/registry.js");
  const timeoutMs = params.timeoutMs ?? ACP_BACKEND_READY_TIMEOUT_MS;
  const pollMs = params.pollMs ?? ACP_BACKEND_READY_POLL_MS;
  const deadline = performance.now() + timeoutMs;

  do {
    const backend = getAcpRuntimeBackend(params.backendId);
    if (backend) {
      try {
        if (!backend.healthy || backend.healthy()) {
          return true;
        }
      } catch {
        // Treat transient backend health probe errors like "not ready yet".
      }
    }
    await sleep(pollMs, undefined, { ref: false });
  } while (performance.now() < deadline);

  return false;
}

/** Start post-ready sidecars such as channels, hooks, plugin services, and cleanup tasks. */
export async function startGatewaySidecars(params: {
  restartSentinelContext?: DeliveryQueueStateContext;
  cfg: OpenClawConfig;
  getModelRuntimeConfig?: () => OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  getCronService?: () => PluginServiceCronHost | null | undefined;
  shouldStartChannels?: () => boolean;
  refreshChatMetadata?: () => Promise<void>;
  onChannelsStarted?: () => Awaitable<void>;
  onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
  onPostReadySidecars: (...sidecars: GatewayPostReadySidecarHandle[]) => void;
  shouldCreatePostReadySidecars?: () => boolean;
  shouldStartPluginServices?: (pendingOwner?: PluginServicesHandle) => boolean;
  pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
  broadcastPluginEvent?: import("./server-broadcast-types.js").GatewayPluginEventBroadcastFn;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
  startupOutcomes?: GatewayStartupOutcomeRecorder;
  mainSessionRecoveryStartupCheckedStorePaths?: Set<string>;
  waitForPostReadyWork?: () => Promise<void>;
}) {
  const restartSentinelContext =
    params.restartSentinelContext ?? captureDeliveryQueueStateContext();
  const postReadySidecars: GatewayPostReadySidecarHandle[] = [];

  const internalHooksConfigured = resolveInternalHookSelection(params.cfg).configured;
  await measureStartup(params.startupTrace, "sidecars.internal-hooks", async () => {
    try {
      const { prepareInternalHooks } = await import("../hooks/loader.js");
      const prepared = await prepareInternalHooks(params.cfg, params.defaultWorkspaceDir, {
        failureMode: "best-effort",
      });
      if (
        params.shouldCreatePostReadySidecars?.() === false ||
        !prepared.commit({ initial: true })
      ) {
        params.startupOutcomes?.record({
          subsystem: "internal-hooks",
          status: "skipped",
          reason: "superseded",
        });
        return;
      }
      if (!internalHooksConfigured) {
        return;
      }
      const { loadedCount } = prepared;
      if (loadedCount > 0) {
        params.startupOutcomes?.record({ subsystem: "internal-hooks", status: "loaded" });
        params.logHooks.info(
          `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
        );
      } else {
        params.startupOutcomes?.record({
          subsystem: "internal-hooks",
          status: "skipped",
          reason: "no-handlers-loaded",
        });
      }
    } catch (err) {
      params.startupOutcomes?.record({
        subsystem: "internal-hooks",
        status: "failed",
        reason: "see earlier log",
      });
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  });

  const mainSessionRecoveryStartupCheckedStorePaths =
    params.mainSessionRecoveryStartupCheckedStorePaths ?? new Set<string>();
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  // These runs were orphaned by the previous Gateway lifecycle. Record that fact
  // even if this process later fails model preparation and never starts channels.
  await measureStartup(params.startupTrace, "sidecars.main-session-recovery", async () => {
    try {
      const { markStartupOrphanedMainSessionsForRecovery } = await measureStartup(
        params.startupTrace,
        "sidecars.main-session-recovery-load",
        loadMainSessionRestartRecoveryMarkingModule,
      );
      await measureStartup(params.startupTrace, "sidecars.main-session-recovery-scan", () =>
        markStartupOrphanedMainSessionsForRecovery({
          cfg: params.cfg,
          startupCheckedStorePaths: mainSessionRecoveryStartupCheckedStorePaths,
        }),
      );
    } catch (err) {
      params.log.warn(
        `main-session startup orphan marking failed before channel startup: ${String(err)}`,
      );
    }
  });
  const getModelRuntimeConfig = params.getModelRuntimeConfig ?? (() => params.cfg);
  // Agent RPC remains available when transports are disabled. Publish configured/static facts before
  // accepting work; live provider catalogs stay advisory and never enter the Gateway lifecycle.
  if ((await params.pluginRuntimeClaim?.waitForUnblocked()) !== false) {
    await measureStartup(params.startupTrace, "sidecars.model-runtime", () =>
      withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
        publishConfiguredModelRuntimeSnapshots({
          cfg: params.cfg,
          getConfig: () =>
            measureStartup(params.startupTrace, "sidecars.model-auth", () =>
              hydrateConfiguredExternalCliAuth({
                getConfig: getModelRuntimeConfig,
                log: params.log,
              }),
            ),
          isCurrent: params.pluginRuntimeClaim?.isCurrent,
          ...(params.pluginMetadataSnapshot
            ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
            : {}),
          workspaceDir: params.defaultWorkspaceDir,
          startupTrace: params.startupTrace,
        }),
      ),
    );
  }
  // Gateway readiness owns process-stable reply module activation so the first operator turn
  // does not become the module loader under contention.
  await measureStartup(params.startupTrace, "sidecars.reply-runtime", async () => {
    const { prewarmConfigDrivenReplyRuntime } = await loadGetReplyFromConfigRuntime();
    await prewarmConfigDrivenReplyRuntime();
  });
  await measureStartup(params.startupTrace, "sidecars.chat-metadata", async () => {
    await params.refreshChatMetadata?.();
  });
  const shouldStartChannels = params.shouldStartChannels?.() !== false;
  await measureStartup(params.startupTrace, "sidecars.channels", async () => {
    const channelStart = skipChannels
      ? measureStartup(params.startupTrace, "sidecars.channel-skip", () =>
          params.logChannels.info(
            "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
          ),
        )
      : shouldStartChannels
        ? measureStartup(params.startupTrace, "sidecars.channel-start", params.startChannels).catch(
            (err: unknown) => params.logChannels.error(`channel startup failed: ${String(err)}`),
          )
        : Promise.resolve();
    // Account tasks can depend on this generation gate, so release it after
    // their handoff is prepared but before waiting for that handoff to settle.
    const accountStartGateRelease = shouldStartChannels ? params.onChannelsStarted?.() : undefined;
    await Promise.all([accountStartGateRelease, channelStart]);
  });

  await params.pluginRuntimeClaim?.waitForUnblocked();
  const shouldStartPluginServices =
    params.pluginRuntimeClaim?.isCurrent() !== false &&
    params.shouldStartPluginServices?.() !== false;
  if (shouldStartPluginServices) {
    let pluginServicesStopRequested = false;
    const ownedPluginServices = createDeferredCore<PluginServicesHandle | null>();
    const pluginServicesOwner: PluginServicesHandle = {
      reload: async (config, serviceIds) => {
        const handle = await ownedPluginServices.promise;
        if (pluginServicesStopRequested || !handle) {
          throw new Error("Plugin services are stopping");
        }
        await handle.reload(config, serviceIds);
      },
      stop: (options) => {
        pluginServicesStopRequested = true;
        // Pending startup owns no services and may be waiting on this replacement.
        ownedPluginServices.resolve(null);
        // Share the service owner, never a caller's expired replacement deadline.
        const stopPromise = ownedPluginServices.promise.then((handle) => handle?.stop(options));
        const deadlineAtMs = options?.strict ? options.deadlineAtMs : undefined;
        if (deadlineAtMs === undefined) {
          return stopPromise;
        }
        return new Promise<Awaited<ReturnType<PluginServicesHandle["stop"]>>>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              reject(
                new AggregateError(
                  [new Error("Gateway plugin service startup did not settle before replacement")],
                  "Gateway plugin service replacement cleanup failed",
                ),
              );
            },
            Math.max(0, deadlineAtMs - Date.now()),
          );
          void stopPromise.then(
            (result) => {
              clearTimeout(timer);
              resolve(result);
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
      },
    };
    // Startup may outlive a replacement deadline. Final shutdown retains this
    // owner without making startup rejoin its pending service cleanup.
    params.onPluginServices?.(pluginServicesOwner);
    await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
      try {
        const { startPluginServices } = await import("../plugins/services.js");
        await params.pluginRuntimeClaim?.waitForUnblocked();
        if (
          pluginServicesStopRequested ||
          params.pluginRuntimeClaim?.isCurrent() === false ||
          params.shouldStartPluginServices?.(pluginServicesOwner) === false
        ) {
          ownedPluginServices.resolve(null);
          return;
        }
        await startPluginServices({
          registry: params.pluginRegistry,
          config: params.cfg,
          workspaceDir: params.defaultWorkspaceDir,
          startupTrace: params.startupTrace,
          broadcastPluginEvent: params.broadcastPluginEvent,
          getCronService: params.getCronService,
          onHandle: (handle) => {
            ownedPluginServices.resolve(handle);
            // Transfer the pending owner to the real service handle before startup yields.
            // A replacement or same-claim recovery must keep its own published handle.
            if (
              params.pluginRuntimeClaim?.isCurrent() !== false &&
              params.shouldStartPluginServices?.(pluginServicesOwner) !== false
            ) {
              params.onPluginServices?.(handle);
            }
          },
        });
      } catch (err) {
        ownedPluginServices.resolve(null);
        params.log.warn(`plugin services failed to start: ${String(err)}`);
      }
    });
  }
  const shouldDispatchGatewayStartupInternalHook =
    internalHooksConfigured || (await hasGatewayStartupInternalHookListeners());
  if (params.shouldCreatePostReadySidecars?.() === false) {
    return 0;
  }
  if (shouldDispatchGatewayStartupInternalHook) {
    params.startupOutcomes?.record({
      subsystem: "internal-startup-hook",
      status: "scheduled",
    });
    // Run startup hooks after sidecar startup has yielded once so gateway bind
    // and channel startup are not delayed by hook handlers.
    // This timer belongs to the current gateway generation; registration lets
    // close cancel it before a replacement generation starts in the same process.
    postReadySidecars.push(
      scheduleGatewayGenerationTimer({
        delayMs: 250,
        origin: "hooks:gateway-startup",
        shouldRun: params.shouldCreatePostReadySidecars,
        run: async (isStopped) => {
          const { createInternalHookEvent, triggerInternalHook } = await loadInternalHooksModule();
          if (isStopped()) {
            return;
          }
          const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
            cfg: params.cfg,
            deps: params.deps,
            workspaceDir: params.defaultWorkspaceDir,
          });
          await triggerInternalHook(hookEvent);
        },
        onError: (err) => params.logHooks.warn(`gateway startup hook failed: ${String(err)}`),
      }),
    );
  }

  if (params.cfg.acp?.enabled) {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (params.shouldCreatePostReadySidecars?.() === false) {
        return;
      }
      const ready = await measureStartup(params.startupTrace, "sidecars.acp.runtime-ready", () =>
        waitForAcpRuntimeBackendReady({ backendId: params.cfg.acp?.backend }),
      );
      params.startupTrace?.detail("sidecars.acp.runtime-ready", [
        ["readyCount", ready ? 1 : 0],
        ["backend", params.cfg.acp?.backend ?? "default"],
      ]);
      if (params.shouldCreatePostReadySidecars?.() === false) {
        return;
      }
      await measureStartup(params.startupTrace, "sidecars.acp.identity-reconcile", async () => {
        const [{ getAcpSessionManager }, { ACP_SESSION_IDENTITY_RENDERER_VERSION }] =
          await Promise.all([
            import("../acp/control-plane/manager.js"),
            import("@openclaw/acp-core/runtime/session-identifiers"),
          ]);
        if (params.shouldCreatePostReadySidecars?.() === false) {
          return;
        }
        const result = await getAcpSessionManager().reconcilePendingSessionIdentities({
          cfg: params.cfg,
        });
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      });
    }, "startup:acp-identity-reconcile").catch((err: unknown) => {
      params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
    });
  }

  let restartSentinelWake: GatewayPostReadySidecarHandle | undefined;
  postReadySidecars.push(
    schedulePostReadySidecarTask({
      startupTrace: params.startupTrace,
      name: "sidecars.restart-sentinel",
      log: params.log,
      waitForPostReadyWork: params.waitForPostReadyWork,
      shouldRun: params.shouldCreatePostReadySidecars,
      run: async (isStopped) => {
        if (!shouldCheckRestartSentinel() || isStopped()) {
          return;
        }
        if (!(await hasRestartSentinel(restartSentinelContext.workerContext.environment))) {
          const { detectLegacyRestartSentinel } =
            await import("../infra/state-migrations.restart-sentinel.js");
          if (
            !detectLegacyRestartSentinel({ stateDir: restartSentinelContext.stateDir }).hasLegacy
          ) {
            return;
          }
        }
        if (isStopped()) {
          return;
        }
        restartSentinelWake = scheduleRestartSentinelWakeAfterReady({
          context: restartSentinelContext,
          deps: params.deps,
          log: params.log,
          shouldRun: params.shouldCreatePostReadySidecars,
        });
      },
      stop: async () => {
        await restartSentinelWake?.stop();
      },
    }),
  );

  if (params.cfg.hooks?.enabled && params.cfg.hooks.gmail?.account) {
    postReadySidecars.push(
      schedulePostReadySidecarTask({
        startupTrace: params.startupTrace,
        name: "sidecars.gmail-watch",
        log: params.log,
        waitForPostReadyWork: params.waitForPostReadyWork,
        shouldRun: params.shouldCreatePostReadySidecars,
        run: async (isStopped, signal) => {
          const { startGmailWatcherWithLogs } = await import("../hooks/gmail-watcher-lifecycle.js");
          if (isStopped()) {
            return;
          }
          await startGmailWatcherWithLogs({
            cfg: params.cfg,
            log: params.logHooks,
            signal,
          });
        },
      }),
    );
  }

  if (params.cfg.hooks?.gmail?.model) {
    postReadySidecars.push(
      schedulePostReadySidecarTask({
        startupTrace: params.startupTrace,
        name: "sidecars.gmail-model",
        log: params.log,
        waitForPostReadyWork: params.waitForPostReadyWork,
        shouldRun: params.shouldCreatePostReadySidecars,
        run: async (isStopped) => {
          const [
            { DEFAULT_MODEL, DEFAULT_PROVIDER },
            { readPreparedModelCatalog },
            { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel },
          ] = await Promise.all([
            loadAgentDefaultsModule(),
            import("../agents/prepared-model-catalog.js"),
            loadAgentModelSelectionModule(),
          ]);
          if (isStopped()) {
            return;
          }
          const hooksModelRef = resolveHooksGmailModel({
            cfg: params.cfg,
            defaultProvider: DEFAULT_PROVIDER,
          });
          if (hooksModelRef) {
            const { provider: resolvedDefaultProvider, model: defaultModel } =
              resolveConfiguredModelRef({
                cfg: params.cfg,
                defaultProvider: DEFAULT_PROVIDER,
                defaultModel: DEFAULT_MODEL,
              });
            const catalog = await readPreparedModelCatalog({
              config: params.cfg,
              readOnly: true,
            });
            if (isStopped()) {
              return;
            }
            const status = getModelRefStatus({
              cfg: params.cfg,
              catalog,
              ref: hooksModelRef,
              defaultProvider: resolvedDefaultProvider,
              defaultModel: { provider: resolvedDefaultProvider, model: defaultModel },
            });
            if (!status.allowed) {
              params.logHooks.warn(
                `hooks.gmail.model "${status.key}" not allowed by agents.defaults.modelPolicy.allow (will use primary instead)`,
              );
            }
            if (!status.inCatalog) {
              params.logHooks.warn(
                `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
              );
            }
          }
        },
      }),
    );
  }

  // These handles schedule later tasks but do not yield after creation. Transfer
  // ownership in the same turn so close cannot seal between creation and publication.
  params.onPostReadySidecars(...postReadySidecars);
  return postReadySidecars.length;
}

type GatewayPostAttachRuntimeDeps = {
  createHookRunner: (
    ...args: Parameters<typeof createHookRunner>
  ) => Awaitable<ReturnType<typeof createHookRunner>>;
  logGatewayStartup: (params: Parameters<typeof logGatewayStartup>[0]) => Awaitable<void>;
  refreshLatestUpdateRestartSentinel: (
    env?: NodeJS.ProcessEnv,
  ) => Awaitable<ReturnType<typeof refreshLatestUpdateRestartSentinel>>;
  createGatewayUpdateCheck: (
    ...args: Parameters<typeof createGatewayUpdateCheck>
  ) => Awaitable<ReturnType<typeof createGatewayUpdateCheck>>;
  startGatewaySidecars: typeof startGatewaySidecars;
  warmSystemCa: typeof warmMacOSSystemCaOffMainThread;
  loadSubagentRegistryActivation: () => Awaitable<
    (resolveGatewayContext: GatewayContextResolver) => void
  >;
};

const defaultGatewayPostAttachRuntimeDeps: GatewayPostAttachRuntimeDeps = {
  createHookRunner: async (...args) =>
    (await import("../plugins/hooks.js")).createHookRunner(...args),
  logGatewayStartup: async (params) =>
    (await import("./server-startup-log.js")).logGatewayStartup(params),
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelIfPresent,
  createGatewayUpdateCheck: async (...args) =>
    (await import("../infra/update-startup.js")).createGatewayUpdateCheck(...args),
  startGatewaySidecars,
  warmSystemCa: beginMacOSSystemCaWarmupOnce,
  loadSubagentRegistryActivation: async () =>
    (await import("../agents/subagents/registry/subagent-registry.js")).activateSubagentRegistry,
};

/** Start work that depends on the HTTP server being attached and visible. */
export async function startGatewayPostAttachRuntime(
  params: {
    minimalTestGateway: boolean;
    updateCanary?: boolean;
    cfgAtStart: OpenClawConfig;
    getConfig: () => OpenClawConfig;
    bindHost: string;
    bindHosts: string[];
    port: number;
    tlsEnabled: boolean;
    log: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
    };
    isNixMode: boolean;
    startupStartedAt?: number;
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) => ReadonlySet<string>;
    broadcastPluginEvent?: import("./server-broadcast-types.js").GatewayPluginEventBroadcastFn;
    controlUiBasePath: string;
    controlUiRootLifecycle?: GatewayControlUiRootLifecycle;
    gatewayPluginConfigAtStart: OpenClawConfig;
    activationSourceConfig: OpenClawConfig;
    pluginManifestRecords: readonly PluginManifestRecord[];
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    ambientEnvTriggers?: AmbientEnvTriggerPolicy;
    pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
    defaultWorkspaceDir: string;
    deps: CliDeps;
    startChannels: () => Promise<void>;
    refreshChatMetadata?: () => Promise<void>;
    recoveryRuntime: GatewayRecoveryRuntime;
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
    pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
    getCurrentPluginRegistry?: () => PluginRegistry;
    getCurrentPluginServices?: () => PluginServicesHandle | null;
    getCurrentPluginMetadataSnapshot?: () => PluginMetadataSnapshot | undefined;
    getCurrentActivationSourceConfig?: () => OpenClawConfig | null;
    getCronService?: () => PluginServiceCronHost | null | undefined;
    onChannelsStarted?: () => Awaitable<void>;
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
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  const restartSentinelContext = captureDeliveryQueueStateContext();
  // The CLI's hidden capability flag supplies this typed internal handoff.
  // Rehearsal loads plugins without resuming copied jobs, services, or notices.
  const candidateCanary = params.updateCanary === true;
  const controlUiRootLifecycle = params.controlUiRootLifecycle;
  const mainSessionRecoveryStartupCheckedStorePaths = new Set<string>();
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
      runtimeDeps.warmSystemCa({ log: params.log }),
    );
  }

  let pluginRegistry = params.pluginRegistry;
  const loadStartupPluginsIfNeeded = async () => {
    if (params.minimalTestGateway || !params.loadStartupPlugins) {
      return;
    }
    params.onStartupPluginsLoading?.();
    const loaded = await measureStartup(params.startupTrace, "plugins.runtime-post-bind", () =>
      params.loadStartupPlugins!(),
    );
    // Shutdown owns attached registries; this startup producer retires discarded results.
    const disposeUnattached = async () => {
      const current = params.getCurrentPluginRegistry?.() ?? pluginRegistry;
      if (loaded.pluginRegistry !== current) {
        loaded.retireGatewayRuntimeBindings?.();
        const { disposePluginRegistryInstances } = await import("../plugins/runtime.js");
        await disposePluginRegistryInstances(loaded.pluginRegistry, current);
      }
      pluginRegistry = current;
    };
    await params.pluginRuntimeClaim?.waitForUnblocked();
    if (params.isClosing?.() || params.pluginRuntimeClaim?.isCurrent() === false) {
      return await disposeUnattached();
    }
    let published: boolean | undefined;
    try {
      published = await params.onStartupPluginsLoaded?.(loaded);
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
  let startupLogOwnerAssigned = false;
  const assignStartupLogOwner = (owner: Promise<void>) => {
    if (params.sidecarStartup !== "defer" || startupLogOwnerAssigned) {
      return;
    }
    startupLogOwnerAssigned = true;
    void owner.then(startupLogSettled.resolve, startupLogSettled.reject);
  };
  const startStartupLog = () => {
    if (startupLogPromise) {
      return startupLogPromise;
    }
    // Sidecar failure can settle public readiness before this producer finishes.
    startupLogPromise = params.trackStartupWork(() => {
      // A replacement can win while plugins load or startup logging is queued.
      // Keep model, trust warnings, and loaded ids on that same runtime generation.
      const startupRuntimeCurrent = params.pluginRuntimeClaim?.isCurrent() !== false;
      const startupPluginRegistry = startupRuntimeCurrent
        ? pluginRegistry
        : (params.getCurrentPluginRegistry?.() ?? pluginRegistry);
      return measureStartup(params.startupTrace, "post-attach.log", () =>
        runtimeDeps.logGatewayStartup({
          cfg: startupRuntimeCurrent ? params.cfgAtStart : params.getConfig(),
          activationSourceConfig: startupRuntimeCurrent
            ? params.activationSourceConfig
            : (params.getCurrentActivationSourceConfig?.() ?? undefined),
          env: process.env,
          manifestRecords: startupRuntimeCurrent
            ? params.pluginManifestRecords
            : (params.getCurrentPluginMetadataSnapshot?.()?.plugins ?? []),
          ...(params.ambientEnvTriggers ? { ambientEnvTriggers: params.ambientEnvTriggers } : {}),
          bindHost: params.bindHost,
          bindHosts: params.bindHosts,
          port: params.port,
          tlsEnabled: params.tlsEnabled,
          loadedPluginIds: startupPluginRegistry.plugins
            .filter((plugin) => plugin.status === "loaded")
            .map((plugin) => plugin.id),
          log: params.log,
          isNixMode: params.isNixMode,
          startupStartedAt: params.startupStartedAt,
        }),
      );
    });
    void startupLogPromise.catch(() => {});
    assignStartupLogOwner(startupLogPromise);
    return startupLogPromise;
  };
  const skipStartupLog = () => assignStartupLogOwner(Promise.resolve());

  const updateCheck =
    params.minimalTestGateway || candidateCanary
      ? { start: () => {}, stop: async () => {} }
      : createDeferredGatewayUpdateCheck({
          startupTrace: params.startupTrace,
          createUpdateCheck: runtimeDeps.createGatewayUpdateCheck,
          getConfig: params.getConfig,
          log: params.log,
          isNixMode: params.isNixMode,
          broadcastToConnIds: params.broadcastToConnIds,
          getClientConnIds: params.getClientConnIds,
          waitForPostReadyWork: params.waitForPostReadyWork,
          isClosing: params.isClosing,
          activeWorkInspectors: params.activeWorkInspectors,
        });
  if (!params.minimalTestGateway) {
    // Startup failure can precede publication of the post-attach return handle.
    params.onGatewayLifetimeSidecars(updateCheck);
  }

  const reportPluginServices = (pluginServices: PluginServicesHandle | null) => {
    if (params.pluginRuntimeClaim?.isCurrent() === false) {
      return;
    }
    params.onPluginServices?.(pluginServices);
  };
  const waitForSidecarStartTurn = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  const startSidecars = () =>
    params.minimalTestGateway
      ? startStartupLog().then(() => pluginRegistry)
      : waitForSidecarStartTurn().then(async () => {
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
          const startupOutcomes = createGatewayStartupOutcomeRecorder({
            cfg: params.gatewayPluginConfigAtStart,
            gatewayStartHooks: hasGatewayStartHooks(pluginRegistry),
          });
          const workerEnvironmentSidecar = params.isClosing?.()
            ? null
            : ((await params.startWorkerEnvironmentRuntime?.()) ?? null);
          if (params.isClosing?.()) {
            return pluginRegistry;
          }
          params.log.info("starting channels and sidecars...");
          const loaderStatsBefore = getPluginModuleLoaderStats();
          const postReadySidecarCount = await (async () => {
            try {
              const startupRuntimeCurrent = params.pluginRuntimeClaim?.isCurrent() !== false;
              const pluginMetadataSnapshot = startupRuntimeCurrent
                ? params.pluginMetadataSnapshot
                : params.getCurrentPluginMetadataSnapshot?.();
              return await measureStartup(params.startupTrace, "sidecars.total", () =>
                runtimeDeps.startGatewaySidecars({
                  restartSentinelContext,
                  cfg: startupRuntimeCurrent
                    ? params.gatewayPluginConfigAtStart
                    : params.getConfig(),
                  getModelRuntimeConfig: params.getConfig,
                  ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
                  pluginRegistry,
                  defaultWorkspaceDir: params.defaultWorkspaceDir,
                  deps: params.deps,
                  getCronService: params.getCronService,
                  startChannels: params.startChannels,
                  shouldStartChannels: () => params.isClosing?.() !== true,
                  refreshChatMetadata: params.refreshChatMetadata,
                  log: params.log,
                  logHooks: params.logHooks,
                  logChannels: params.logChannels,
                  startupTrace: params.startupTrace,
                  onChannelsStarted: params.onChannelsStarted,
                  onPluginServices: reportPluginServices,
                  onPostReadySidecars: params.onPostReadySidecars,
                  shouldCreatePostReadySidecars: () => params.isClosing?.() !== true,
                  shouldStartPluginServices: (pendingOwner) => {
                    const current = params.getCurrentPluginServices?.();
                    return (
                      params.isClosing?.() !== true &&
                      (current === undefined || current === null || current === pendingOwner)
                    );
                  },
                  ...(params.pluginRuntimeClaim
                    ? { pluginRuntimeClaim: params.pluginRuntimeClaim }
                    : {}),
                  broadcastPluginEvent: params.broadcastPluginEvent,
                  startupOutcomes,
                  mainSessionRecoveryStartupCheckedStorePaths,
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
          let mainSessionRecoverySidecar: GatewayPostReadySidecarHandle | undefined;
          await startupLog;
          if (params.isClosing?.()) {
            return pluginRegistry;
          }
          try {
            const { scheduleRestartAbortedMainSessionRecovery } =
              await loadMainSessionRestartRecoveryModule();
            if (params.isClosing?.() !== true) {
              mainSessionRecoverySidecar = scheduleRestartAbortedMainSessionRecovery({
                delayMs: 0,
                getConfig: params.getConfig,
                shouldContinue: () => params.isClosing?.() !== true,
                startupCheckedStorePaths: mainSessionRecoveryStartupCheckedStorePaths,
                waitForStart: params.waitForPostReadyWork,
                gatewayRuntime: params.recoveryRuntime,
              });
            }
          } catch (err) {
            params.log.warn(`main-session restart recovery failed to schedule: ${String(err)}`);
          }
          if (params.isClosing?.()) {
            if (mainSessionRecoverySidecar) {
              params.onGatewayLifetimeSidecars(mainSessionRecoverySidecar);
            }
            return pluginRegistry;
          }
          // Capture the orphan-recovery cutoff before new startup-gated agent
          // work can create sessions that the recovery scan must leave alone.
          params.unlockStartupMethods();
          const newGatewayLifetimeSidecars = [
            scheduleContextCachePrewarm(params),
            scheduleGatewayHandlerPrewarm(params),
            ...(mainSessionRecoverySidecar ? [mainSessionRecoverySidecar] : []),
          ];
          const transcriptsConfig =
            params.pluginRuntimeClaim?.isCurrent() === false
              ? params.getConfig()
              : params.gatewayPluginConfigAtStart;
          newGatewayLifetimeSidecars.push(
            scheduleTranscriptsSidecar({
              cfg: transcriptsConfig,
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
          params.onSidecarsReady?.();
          try {
            const activateSubagentRegistry = await runtimeDeps.loadSubagentRegistryActivation();
            if (params.isClosing?.() !== true) {
              activateSubagentRegistry(params.resolveGatewayContext);
            }
          } catch (err) {
            params.log.warn(`subagent restart recovery failed to activate: ${String(err)}`);
          }
          if (params.isClosing?.()) {
            return pluginRegistry;
          }
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
      await runGatewayStartupObservers({
        registry: sidecarRegistry,
        signal,
        port: params.port,
        config: params.gatewayPluginConfigAtStart,
        workspaceDir: params.defaultWorkspaceDir,
        getCron: () =>
          (params.getCronService?.() ?? params.deps.cron) as
            | PluginHookGatewayCronService
            | undefined,
        isClosing: params.isClosing,
        waitForPostReadyWork: params.waitForPostReadyWork,
        startupTrace: params.startupTrace,
        log: params.log,
        logHooks: params.logHooks,
        createHookRunner: runtimeDeps.createHookRunner,
        refreshLatestUpdateRestartSentinel: () =>
          runtimeDeps.refreshLatestUpdateRestartSentinel(
            restartSentinelContext.workerContext.environment,
          ),
      });
    })
    .catch((err: unknown) => {
      params.log.warn(`gateway sidecars failed to start: ${String(err)}`);
    });

  if (params.sidecarStartup !== "defer") {
    await sidecarsPromise;
    updateCheck.start();
    return {
      stopGatewayUpdateCheck: updateCheck.stop,
      startupSettled: Promise.resolve(),
    };
  }

  updateCheck.start();
  const startupSettled = Promise.all([sidecarsPromise, startupLogSettled.promise]).then(
    () => undefined,
  );
  // Direct callers may ignore this handle; only the managed run loop observes it.
  // Pre-handle so an ignored deferred sidecar failure never becomes an unhandled rejection.
  void startupSettled.catch(() => {});

  return {
    stopGatewayUpdateCheck: updateCheck.stop,
    startupSettled,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
