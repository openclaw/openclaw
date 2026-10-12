import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshotForRuntimeTransaction,
  registerConfigWriteListener,
} from "../config/io.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { isNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { resolveGatewayAuth } from "./auth.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";
import {
  indexPluginNodeCapabilitySurfaces,
  reconcileClientPluginNodeCapabilities,
} from "./plugin-node-capability.js";
import { collectGatewayProcessMemoryUsageMb, finishGatewayRestartTrace } from "./restart-trace.js";
import { activateGatewayAgentDatabaseStartup } from "./server-agent-database-startup.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import { clearGatewayMaintenanceHandles } from "./server-maintenance-lifecycle.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { refreshConnectedNodeSurfaceCaches } from "./server-methods/nodes.read.js";
import { assertGatewayRuntimeSecurityConfig } from "./server-runtime-config.js";
import { logGatewayReady } from "./server-startup-readiness.js";
import { startGatewayTlsRenewal } from "./server-tls-renewal.js";
import type { GatewayHttpTransport } from "./server-transport-bridge.js";
import { startWorkerHumanPresence } from "./server/client-human-presence.js";
import { collectGatewayWorkerPoolMetrics } from "./server/process-vitals.js";
import { disconnectDisallowedGatewayPolicyClients } from "./server/ws-origin-policy.js";
import { DEFAULT_TERMINAL_DETACH_SECONDS } from "./terminal/session-limits.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
const [POST_READY_MAINTENANCE_DELAY_MS, RETAINED_PLUGIN_CLEANUP_DELAY_MS] = [250, 30_000];

type GatewayStartedRuntime = GatewayKernelRuntime & GatewayHttpTransport;

export async function finishGatewayStartup(params: {
  kernelRuntime: GatewayStartedRuntime;
  port: number;
  bootId: string;
  opts: GatewayStartedRuntime["opts"];
  log: GatewayLogger;
  logHealth: GatewayLogger;
  logWsControl: GatewayLogger;
  logHooks: GatewayLogger;
  logChannels: GatewayLogger;
  logCron: GatewayLogger;
  logReload: GatewayLogger;
  waitForPostReadyWork: () => Promise<void>;
}) {
  const {
    kernelRuntime: runtime,
    port,
    bootId,
    opts,
    log,
    logHealth,
    logWsControl,
    logHooks,
    logChannels,
    logCron,
    logReload,
  } = params;
  const {
    minimalTestGateway,
    deps,
    runtimeState,
    kernel,
    startupTrace,
    broadcast,
    broadcastToConnIds,
    clients,
    sharedGatewaySessionGenerationState,
    workerEnvironmentService,
    workerPlacementRuntime,
    terminalLaunchPolicy,
    terminalSessions,
    nodeRegistry,
    nodeDesktopService,
    startChannel,
    stopChannel,
    getAttachedGatewayMethodRegistry,
    lifecycle,
    startupState,
    pluginRuntime,
    resolvePluginGatewayContext,
    gatewayTls,
    bindHost,
    getResolvedAuth,
    authRateLimiter,
    browserAuthRateLimiter,
    nodeReapprovalCoordinator,
    isGatewayStartupPending,
    attachedGatewayExtraHandlers,
    startListening,
    gatewayPluginConfigAtStart,
    startupActivationSourceConfig,
    defaultWorkspaceDir,
    coreGatewayMethodNames,
    pluginHostServices,
    baseMethods,
    startupPluginIds,
    pluginManifestRecords,
    pluginMetadataSnapshot,
    pluginLookUpTable,
    ambientEnvTriggers,
    prepareAttachedPluginRuntime,
    refreshAttachedGatewayDiscovery,
    wss,
    startChannels,
    broadcastPluginEvent,
    controlUiRootLifecycle,
    sidecarStartup,
    startEarlyRuntime,
    cfgAtStart,
    preauthConnectionBudget,
    releaseStartupAccountStarts,
    cronReconciliation,
    cronStartState,
    prepareReloadCandidate,
    configSnapshot,
    channelManager,
    activateRuntimeSecrets,
    applyFixedGatewayOverlays,
    resolveSharedGatewaySessionGenerationForConfig,
    stopRegisteredPostReadySidecars,
    registerPostReadySidecars,
    registerGatewayLifetimeSidecars,
    registerConnectionDependentSidecars,
    unregisterConnectionDependentSidecar,
    chatMetadataLifecycle,
    gatewayRequestContext,
    gatewayInstanceRuntime,
    getPluginMetadataSnapshot,
    getPluginNodeCapabilities,
  } = runtime;
  const startupPluginRuntimeClaim = kernel.pluginRuntimeGeneration.currentClaim();
  const databaseStartupAdmission = getAgentDatabaseStartupAdmission();
  const databasePreparationReady = createDeferredCore();
  const activateAgentDatabases = () => {
    if (databaseStartupAdmission && !opts.updateCanary && !lifecycle.closePreludeStarted) {
      activateGatewayAgentDatabaseStartup({
        admission: databaseStartupAdmission,
        preparationReady: databasePreparationReady.promise,
        getConfig: getRuntimeConfig,
        getPluginRegistry: () => pluginRuntime.registry,
        getPluginMetadataSnapshot,
        isCurrent: () => !lifecycle.closePreludeStarted,
        log,
      });
    }
  };
  const getReadiness = runtime.createHttpTransportOptions().getReadiness;
  const { attachGatewayWsConnectionHandler } = await startupTrace.measure(
    "gateway.ws-imports",
    () => import("./server/ws-connection.js"),
  );
  if (workerEnvironmentService) {
    await startWorkerHumanPresence({
      clients,
      service: workerEnvironmentService,
      log,
      registerSidecar: registerGatewayLifetimeSidecars,
    });
  }
  await startupTrace.measure("gateway.ws-attach", () =>
    attachGatewayWsConnectionHandler({
      wss,
      clients,
      connectionWork: runtime.connectionWork,
      bootId,
      preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      pluginSurfaceScheme: gatewayTls.enabled ? "https" : "http",
      getPluginNodeCapabilities,
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration: sharedGatewaySessionGenerationState.reader,
      rateLimiter: authRateLimiter,
      browserRateLimiter: browserAuthRateLimiter,
      nodeReapprovalCoordinator,
      isStartupPending: isGatewayStartupPending,
      isPendingWorkerNodeSetup: workerEnvironmentService?.hasPendingNodeEnrollmentSetup,
      admitsNodeSetupCompletion: workerEnvironmentService?.admitsNodeSetupCompletion,
      gatewayMethods: runtimeState.gatewayMethods,
      events: GATEWAY_EVENTS,
      logGateway: log,
      logHealth,
      logWsControl,
      extraHandlers: attachedGatewayExtraHandlers,
      getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
      ...(workerEnvironmentService ? { workerConnectionService: workerEnvironmentService } : {}),
      broadcast,
      refreshHealthSnapshot: gatewayRequestContext.refreshHealthSnapshot,
      buildRequestContext: () => gatewayRequestContext,
    }),
  );
  await startupTrace.measure("http.listen", () => startListening());
  kernel.setDispatchReady(true);
  startupTrace.mark("http.bound");
  if (!minimalTestGateway && !opts.updateCanary) {
    const { startOpenClawDatabaseIntegrityVerifier } =
      await import("../state/openclaw-database-verify.js");
    registerGatewayLifetimeSidecars(startOpenClawDatabaseIntegrityVerifier({ env: process.env }));
  }
  activateAgentDatabases();
  // Health can answer as soon as the listener binds. Discovery, remote-skill
  // setup, and maintenance do not determine liveness, so keep them off that
  // critical path while still completing before usable readiness.
  const earlyRuntime = await startEarlyRuntime();
  const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
  let postAttachRuntimeReturned = false;
  let scheduledServicesActivated = false;
  const activateScheduledServicesWhenReady = () => {
    if (
      opts.updateCanary ||
      lifecycle.closePreludeStarted ||
      !postAttachRuntimeReturned ||
      !startupState.sidecarsReady ||
      scheduledServicesActivated
    ) {
      return;
    }
    scheduledServicesActivated = true;
    void import("./server-runtime-services.js").then((gatewayRuntimeServices) => {
      if (lifecycle.closePreludeStarted) {
        return;
      }
      const activated = gatewayRuntimeServices.activateGatewayScheduledServices({
        scheduler: runtime.scheduler,
        minimalTestGateway,
        cfgAtStart,
        deps,
        sessionDeliveryRecoveryMaxEnqueuedAt,
        cronEnabled: runtimeState.cronState.cronEnabled,
        log,
        resolveGatewayContext: resolvePluginGatewayContext,
      });
      kernel.setScheduledServiceHandles(activated);
    });
  };
  const { startGatewayActiveWork } = await startupTrace.measure(
    "gateway.active-work-import",
    () => import("./server-work-metrics.js"),
  );
  const activeWorkInspectors = startGatewayActiveWork(runtime, log);
  const trackStartupWork = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    // Register before starting, without lending the connection scope to long-lived services.
    const operation = Promise.resolve().then(() => run(runtime.connectionWork.signal));
    return runtime.connectionWork.track(() => operation);
  };
  const postAttachHandles = await trackStartupWork(() =>
    startupTrace.measure("runtime.post-attach", () =>
      import("./server-startup-post-attach.js").then(({ startGatewayPostAttachRuntime }) =>
        startGatewayPostAttachRuntime({
          scheduler: runtime.scheduler,
          minimalTestGateway,
          updateCanary: opts.updateCanary,
          cfgAtStart,
          getConfig: getRuntimeConfig,
          port,
          log,
          isNixMode,
          startupStartedAt: opts.startupStartedAt,
          broadcastToConnIds,
          getClientConnIds: gatewayRequestContext.getClientConnIds!,
          broadcastPluginEvent,
          controlUiRootLifecycle,
          gatewayPluginConfigAtStart,
          activationSourceConfig: startupActivationSourceConfig,
          pluginManifestRecords,
          ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
          pluginRuntimeClaim: startupPluginRuntimeClaim,
          getCurrentPluginRegistry: () => pluginRuntime.registry,
          getCurrentPluginServices: () => kernel.pluginRuntimeGeneration.currentServices(),
          getCurrentPluginMetadataSnapshot: getPluginMetadataSnapshot,
          getCurrentActivationSourceConfig: getRuntimeConfigSourceSnapshot,
          ambientEnvTriggers,
          pluginRegistry: pluginRuntime.registry,
          defaultWorkspaceDir,
          deps,
          startChannels,
          recoveryRuntime: gatewayInstanceRuntime.recovery,
          isRestartRecoverySuppressed: () => channelManager.getAutostartSuppression() !== null,
          resolveGatewayContext: gatewayRequestContext.resolveGatewayContext!,
          logHooks,
          logChannels,
          unlockStartupMethods: kernel.unlockStartupMethods,
          refreshChatMetadata: chatMetadataLifecycle.refresh,
          loadStartupPlugins: async () => {
            const { loadGatewayStartupPluginRuntime } = await import("./server-startup-plugins.js");
            return loadGatewayStartupPluginRuntime({
              cfg: gatewayPluginConfigAtStart,
              activationSourceConfig: startupActivationSourceConfig,
              workspaceDir: runtime.pluginWorkspaceDir,
              log,
              baseMethods,
              coreGatewayMethodNames,
              hostServices: pluginHostServices,
              startupPluginIds,
              pluginLookUpTable,
              startupTrace,
              ambientEnvTriggers,
              resolveGatewayContext: resolvePluginGatewayContext,
              pluginRuntimeClaim: startupPluginRuntimeClaim,
              getCurrentPluginRegistry: () => pluginRuntime.registry,
            });
          },
          onStartupPluginsLoading: () => {
            startupState.pendingReason = "startup-sidecars";
          },
          onStartupPluginsLoaded: async (loaded) => {
            const activationCleanup: Promise<void>[] = [];
            const prepared = await prepareAttachedPluginRuntime(loaded, (completion) =>
              activationCleanup.push(completion),
            );
            try {
              if (
                lifecycle.closePreludeStarted ||
                !startupPluginRuntimeClaim.publish(prepared.publish)
              ) {
                return false;
              }
              startupState.pendingReason = "startup-sidecars";
              prepared.afterCommit();
              // Nodes can finish their handshake before deferred plugins attach.
              const nodeCapabilitySurfaces = indexPluginNodeCapabilitySurfaces(
                getPluginNodeCapabilities(),
              );
              for (const client of clients) {
                reconcileClientPluginNodeCapabilities(client, nodeCapabilitySurfaces);
              }
              await refreshAttachedGatewayDiscovery(
                loaded.pluginRegistry,
                startupPluginRuntimeClaim,
              );
              return true;
            } finally {
              await Promise.allSettled(activationCleanup);
            }
          },
          getCronService: kernel.getCronService,
          onChannelsStarted: () => {
            releaseStartupAccountStarts();
          },
          onPluginServices: (pluginServices) => {
            kernel.pluginRuntimeGeneration.publishServices(
              startupPluginRuntimeClaim,
              pluginServices,
            );
          },
          onPostReadySidecars: registerPostReadySidecars,
          onGatewayLifetimeSidecars: registerGatewayLifetimeSidecars,
          trackStartupWork,
          unregisterConnectionDependentSidecar,
          ...(workerPlacementRuntime
            ? {
                startWorkerEnvironmentRuntime: async () => {
                  if (lifecycle.closePreludeStarted) {
                    return null;
                  }
                  return await workerPlacementRuntime.startRuntime({
                    isClosePreludeStarted: () => lifecycle.closePreludeStarted,
                    // Close must see the drain handle before reconciliation can yield.
                    registerSidecar: (sidecar) => {
                      registerConnectionDependentSidecars(sidecar);
                    },
                    unregisterSidecar: unregisterConnectionDependentSidecar,
                  });
                },
              }
            : {}),
          onSidecarsReady: () => {
            kernel.markSidecarsReady();
            databasePreparationReady.resolve();
            activateScheduledServicesWhenReady();
          },
          getReadiness,
          isClosing: () => lifecycle.closePreludeStarted,
          startupTrace,
          sidecarStartup,
          waitForPostReadyWork: params.waitForPostReadyWork,
          activeWorkInspectors,
        }),
      ),
    ),
  );
  kernel.setPostAttachHandles(postAttachHandles);
  if (minimalTestGateway) {
    databasePreparationReady.resolve();
  }
  startupTrace.detail("memory.ready", [
    ...collectGatewayProcessMemoryUsageMb(),
    ...(minimalTestGateway
      ? []
      : await startupTrace.measure("runtime.worker-pool-metrics", collectGatewayWorkerPoolMetrics)),
  ]);
  if (getReadiness().ready) {
    startupTrace.mark("ready");
    if (sidecarStartup === "defer") {
      logGatewayReady({ getReadiness, log });
    }
  }
  finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
  if (opts.updateCanary) {
    // Copied queues and jobs must not resume; the canary owns only startup probes.
    return { startupSettled: postAttachHandles.startupSettled };
  }
  postAttachRuntimeReturned = true;
  activateScheduledServicesWhenReady();

  const { startManagedGatewayConfigReloader } = await import("./server-reload-managed.js");
  const assertRuntimeSecurityConfig = (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) => {
    assertGatewayRuntimeSecurityConfig({
      cfg,
      port,
      bindHost,
      controlUiEnabled: opts.controlUiEnabled ?? cfg.gateway?.controlUi?.enabled ?? true,
      tailscaleMode: runtime.tailscaleMode,
      resolvedAuth: resolveGatewayAuth({
        authConfig: cfg.gateway?.auth,
        tailscaleMode: runtime.tailscaleMode,
        env,
      }),
    });
  };
  const tlsRenewal = startGatewayTlsRenewal({
    scheduler: runtime.scheduler,
    runtime: gatewayTls,
    servers: runtime.httpServers,
    enabled: cfgAtStart.gateway?.reload?.mode !== "off",
    onRenewed: async () =>
      runtimeState.discovery?.update({
        gatewayTlsFingerprintSha256: gatewayTls.fingerprintSha256,
      }),
    log: log.child("tls"),
  });
  if (tlsRenewal) {
    registerGatewayLifetimeSidecars(tlsRenewal);
  }
  let appliedCustomPluginUiEnabled =
    gatewayPluginConfigAtStart.gateway?.controlUi?.experimental?.customPlugins === true;
  const configReloaderParams: Parameters<typeof startManagedGatewayConfigReloader>[0] = {
    scheduler: runtime.scheduler,
    onReloadEnabledChange: tlsRenewal?.setEnabled,
    configRevisionProjector: gatewayRequestContext.configRevisionProjector,
    resolveGatewayContext: resolvePluginGatewayContext,
    minimalTestGateway,
    initialConfig: cfgAtStart,
    initialPluginInstallRecords: pluginMetadataSnapshot?.index.installRecords,
    initialCompareConfig: configSnapshot.sourceConfig,
    initialSnapshotRawHash: configSnapshot.exists ? hashConfigRaw(configSnapshot.raw) : null,
    initialAuthoredConfig: configSnapshot.parsed,
    initialIncludedPaths: configSnapshot.includedPaths ?? [],
    initialSnapshotValid: configSnapshot.valid,
    initialSnapshotIssues: configSnapshot.issues,
    watchPath: configSnapshot.path,
    readSnapshot: readConfigFileSnapshotForRuntimeTransaction,
    promoteSnapshot: promoteConfigSnapshotToLastKnownGood,
    subscribeToWrites: (listener) =>
      registerConfigWriteListener(listener, {
        ownsRuntimeActivationFor: configSnapshot.path,
        prepareSnapshot: opts.prepareConfigSnapshot,
        preCommitRuntimePreflight: async (sourceConfig, runtimeRefresh) => {
          const candidate = await prepareReloadCandidate({
            runtimeConfig: sourceConfig,
            sourceConfig,
          });
          const prepared = await activateRuntimeSecrets(candidate.runtimeConfig, {
            reason: "reload",
            activate: false,
            env: candidate.runtimeEnv.env,
            includeAuthStoreRefs: runtimeRefresh?.includeAuthStoreRefs,
          });
          const previousConfig = getRuntimeConfig();
          // Runtime defaults and startup overlays are not authored changes; they
          // must not classify a hot write as a restart and bypass this validation.
          const plan = buildGatewayReloadPlan(
            diffGatewayReloadPaths(
              getRuntimeConfigSourceSnapshot() ?? configSnapshot.sourceConfig,
              sourceConfig,
              listConfigReloadRefinementPrefixes(),
            ),
            { previousConfig, candidateConfig: prepared.config },
          );
          if (runtimeRefresh?.requireImmediateApplication) {
            if (prepared.config.gateway?.reload?.mode === "off") {
              throw new Error(
                "The saved sign-in is inactive because Gateway reload is disabled. Enable config reload and restart the Gateway before retrying it.",
              );
            }
            if (plan.restartGateway || plan.reloadPlugins) {
              throw new Error(
                plan.reloadPlugins
                  ? "Update or enable the selected provider plugin in Plugins, then retry this saved sign-in. Your current connection is unchanged."
                  : "Apply the required Gateway settings update separately, then retry this saved sign-in. Your current connection is unchanged.",
              );
            }
          }
          if (!plan.restartGateway) {
            assertRuntimeSecurityConfig(prepared.config, candidate.runtimeEnv.env);
          }
          return candidate;
        },
      }),
    deps,
    broadcast,
    getState: kernel.getReloadState,
    setState: (nextState) => {
      kernel.setReloadHookState(nextState);
      kernel.setHeartbeatRunner(nextState.heartbeatRunner);
      const previousCronState = kernel.swapCronState(nextState.cronState);
      if (previousCronState !== nextState.cronState) {
        cronStartState.handled = true;
      }
    },
    getPluginMetadataSnapshot,
    getPluginRegistry: () => runtime.pluginRuntime.registry,
    startChannel,
    stopChannel,
    getChannelAutostartSuppression: channelManager.getAutostartSuppression,
    stopPostReadySidecars: stopRegisteredPostReadySidecars,
    reloadPlugins: kernel.reloadPlugins,
    reloadPluginServices: async (config, serviceIds) => {
      const services = runtimeState.pluginServices;
      if (!services) {
        throw new Error("Plugin services are not attached");
      }
      await services.reload(config, serviceIds);
    },
    logHooks,
    logChannels,
    logCron,
    logReload,
    cronReconciliation,
    onCronRestart: () => {
      cronStartState.handled = true;
    },
    prepareTerminalConfig: (plan, nextConfig) => {
      terminalLaunchPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
    },
    reconcileRuntimePolicy: async (nextConfig, phase) => {
      terminalSessions.closeDisallowedAgents((agentId) => terminalLaunchPolicy.resolve(agentId).ok);
      if (phase !== "committed") {
        return;
      }
      terminalSessions.updateDetachGraceMs(
        (nextConfig.gateway?.terminal?.detachedSessionTimeoutSeconds ??
          DEFAULT_TERMINAL_DETACH_SECONDS) * 1000,
      );
      disconnectDisallowedGatewayPolicyClients(clients.authorityClients, nextConfig);
      for (const nodeSession of nodeRegistry.refreshRuntimePolicy(nextConfig)) {
        refreshConnectedNodeSurfaceCaches({ context: gatewayRequestContext, nodeSession });
      }
      const reconciled = await Promise.allSettled([
        runtime.hostDesktopService.reconcileRuntimePolicy(),
        runtime.gatewayComputerService.reconcileRuntimePolicy(),
        workerEnvironmentService?.reconcileDesktopPolicy(),
        nodeDesktopService.reconcileRuntimePolicy(),
        runtimeState.discovery?.update({ mdnsMode: nextConfig.discovery?.mdns?.mode }),
        (async () => {
          const customPluginUiEnabled =
            nextConfig.gateway?.controlUi?.experimental?.customPlugins === true;
          if (customPluginUiEnabled !== appliedCustomPluginUiEnabled) {
            const { listControlUiPluginCatalog } = await import("./control-ui-plugin-assets.js");
            const catalog = await listControlUiPluginCatalog();
            broadcast("plugins.controlUi.changed", { revision: catalog.revision });
            appliedCustomPluginUiEnabled = customPluginUiEnabled;
          }
        })(),
      ]);
      const failed = reconciled.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
    },
    commitRuntimePolicy: (nextConfig) => {
      controlUiRootLifecycle.setEnabled(
        opts.controlUiEnabled ?? nextConfig.gateway?.controlUi?.enabled ?? true,
      );
      runtime.configureDiagnostics(nextConfig);
      runtimeState.reconcileAuditPolicy?.(nextConfig);
      const rateLimit = nextConfig.gateway?.auth?.rateLimit;
      authRateLimiter.updateConfig(rateLimit);
      browserAuthRateLimiter.updateConfig({ ...rateLimit, exemptLoopback: false });
      nodeReapprovalCoordinator.updateConfig(rateLimit);
      terminalLaunchPolicy.commitConfig();
      workerEnvironmentService?.schedulePreparedRefill();
    },
    acceptTerminalConfig: terminalLaunchPolicy.acceptConfig,
    channelManager,
    activateRuntimeSecrets,
    assertRuntimeSecurityConfig,
    prepareConfigCandidate: prepareReloadCandidate,
    applyRuntimeConfigOverrides: applyFixedGatewayOverlays,
    resolveSharedGatewaySessionGenerationForConfig,
    sharedGatewaySessionGenerationState,
    clients,
    ...(opts.hotReloadRecovery ? { requestRecoveryRestart: opts.hotReloadRecovery } : {}),
    restartRecoveryAvailable: opts.hotReloadRecovery !== undefined,
  };
  if (lifecycle.closePreludeStarted) {
    return { startupSettled: postAttachHandles.startupSettled };
  }
  const configReloader = startManagedGatewayConfigReloader(configReloaderParams);
  kernel.setConfigReloaderHandle(configReloader);
  await configReloader.ready;
  if (lifecycle.closePreludeStarted) {
    return { startupSettled: postAttachHandles.startupSettled };
  }
  await promoteConfigSnapshotToLastKnownGood(configSnapshot).catch((err: unknown) => {
    log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
  });
  if (!minimalTestGateway) {
    const gatewayRuntimeServices = await import("./server-runtime-services.js");
    gatewayRuntimeServices.scheduleGatewayPostReadyMaintenance({
      scheduler: runtime.scheduler,
      signal: runtime.connectionWork.signal,
      delayMs: POST_READY_MAINTENANCE_DELAY_MS,
      isClosing: () => lifecycle.closePreludeStarted,
      waitForPostReadyWork: params.waitForPostReadyWork,
      startupMaintenance: runtime,
      startMaintenance: () =>
        earlyRuntime.startMaintenance(activeWorkInspectors, resolvePluginGatewayContext),
      applyMaintenance: async (maintenance) => {
        if (lifecycle.closePreludeStarted) {
          await clearGatewayMaintenanceHandles(maintenance);
          return;
        }
        // Publish the stop owner before cleanup can touch SQLite or state paths;
        // shutdown may begin immediately after this synchronous handoff.
        kernel.setMaintenanceHandles(maintenance);
        maintenance.startMediaCleanup();
      },
      shouldStartCron: () => !lifecycle.closePreludeStarted && !cronStartState.handled,
      markCronStartHandled: () => {
        cronStartState.handled = true;
      },
      cronState: runtimeState.cronState,
      cronReconciliation,
      cronConfig: cfgAtStart,
      logCron,
      log,
      recordPostReadyMemory: () => {
        startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
      },
    });
    // This Gateway may still import boot-generation code after an install retires
    // it. Capture those paths before the idle delay; cleanup also protects the new ledger.
    const startupInstallPaths = [
      ...Object.values(pluginMetadataSnapshot?.index.installRecords ?? {}).flatMap((record) =>
        record.installPath ? [record.installPath] : [],
      ),
      ...(pluginMetadataSnapshot?.plugins.flatMap((record) =>
        record.setupSource
          ? [record.rootDir, record.source, record.setupSource]
          : [record.rootDir, record.source],
      ) ?? []),
    ];
    registerGatewayLifetimeSidecars(
      gatewayRuntimeServices.scheduleGatewayIdleTask({
        id: "maintenance:retained-plugin-generations",
        scheduler: runtime.scheduler,
        delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        isClosing: () => lifecycle.closePreludeStarted,
        isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
        run: async () => {
          await params.waitForPostReadyWork();
          const { cleanupGatewayRetiredPluginArtifacts } =
            await import("./server-retained-plugin-cleanup.js");
          await cleanupGatewayRetiredPluginArtifacts({
            log,
            startupInstallPaths,
            signal: runtime.connectionWork.signal,
            assertCurrent: () => {
              if (lifecycle.closePreludeStarted) {
                throw runtime.connectionWork.signal.reason ?? new Error("Gateway is closing");
              }
            },
          });
        },
        log,
        errorMessage: "retained npm generation cleanup failed",
      }),
    );
    registerGatewayLifetimeSidecars(
      gatewayRuntimeServices.scheduleGatewayIdleTask({
        id: "maintenance:sqlite-snapshots",
        scheduler: runtime.scheduler,
        delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        isClosing: () => lifecycle.closePreludeStarted,
        isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
        repeatDelayMs: 15 * 60_000,
        run: async () => {
          const { reclaimAbandonedSqliteSnapshotsAsync } =
            await import("../infra/sqlite-snapshot-staging.js");
          await reclaimAbandonedSqliteSnapshotsAsync();
        },
        log,
        errorMessage: "SQLite snapshot staging cleanup failed",
      }),
    );
  } else {
    startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
  }
  return { startupSettled: postAttachHandles.startupSettled };
}
