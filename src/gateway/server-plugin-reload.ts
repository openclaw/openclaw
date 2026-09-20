import { randomUUID } from "node:crypto";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { withCoreCanvasNodeCapability } from "../canvas/constants.js";
import { validateConfiguredBindings } from "../channels/plugins/configured-binding-registry.js";
import { getRuntimeConfig } from "../config/io.js";
import { prepareDecisionProviderReload } from "../decisions/runtime.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { prepareGatewayPluginMetadataSnapshotPublication } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-gateway.types.js";
import {
  PluginHostCleanupTimeoutError,
  withPluginHostCleanupTimeout,
} from "../plugins/host-hook-cleanup-timeout.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { PluginLoadFailureError } from "../plugins/loader-shared.js";
import { prepareMemoryRuntimeReload } from "../plugins/memory-runtime.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRegistryPreparationScope } from "../plugins/registry-lifecycle.js";
import { getPluginRegistryVersion } from "../plugins/runtime-state.js";
import { waitForPluginRegistryRetirement } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import {
  getGatewayRestartDrainSignal,
  waitForGatewayRestartFenceSettlement,
} from "../process/gateway-work-admission.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import {
  indexPluginNodeCapabilitySurfaces,
  prepareClientPluginNodeCapabilities,
  reconcileClientPluginNodeCapabilities,
} from "./plugin-node-capability.js";
import type { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import { createPluginReloadChannels } from "./server-plugin-reload-channels.js";
import {
  createPluginReloadCleanup,
  createPluginReloadDiagnostics,
  PluginAdmittedWorkTimeoutError,
} from "./server-plugin-reload-cleanup.js";
import {
  createPluginReloadRecovery,
  resolvePluginReloadReplacementIds,
} from "./server-plugin-reload-recovery.js";
import {
  GatewayConfigReloadSupersededError,
  type GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";
import { listPluginNodeCapabilities } from "./server/plugins-http/route-capability.js";

export async function reloadGatewayPlugins(
  {
    runtime,
    port,
    log,
    loadGatewayPluginBootstrapModule,
    prepareAttachedPluginRuntime,
  }: {
    runtime: Awaited<ReturnType<typeof prepareGatewayLifecycle>>;
    port: number;
    log: ReturnType<typeof createSubsystemLogger>;
    loadGatewayPluginBootstrapModule: () => Promise<typeof import("./server-plugin-bootstrap.js")>;
    prepareAttachedPluginRuntime: (loaded: ReturnType<typeof prepareGatewayPluginLoad>) => Promise<{
      publish: () => void;
      afterCommit: () => void;
    }>;
  },
  params: Parameters<GatewayReloadHandlerParams["reloadPlugins"]>[0],
): ReturnType<GatewayReloadHandlerParams["reloadPlugins"]> {
  const restartDrainSignal = getGatewayRestartDrainSignal();
  const { prepareGatewayPluginLoad: preparePlugins } = await loadGatewayPluginBootstrapModule();
  const {
    pluginRuntime,
    kernel,
    pluginWorkspaceDir,
    runtimeState,
    ambientEnvTriggers,
    workerEnvironmentStartup,
    coreGatewayMethodNames,
    pluginHostServices,
    baseMethods,
    resolvePluginGatewayContext,
    channelManager,
    broadcastPluginEvent,
    clients,
    broadcast,
  } = runtime;
  const previousRegistry = pluginRuntime.registry;
  const previousConfig = getRuntimeConfig();
  const previousServices = kernel.pluginRuntimeGeneration.currentServices();
  const previousMetadata = runtime.pluginMetadataSnapshot;
  const previousLoadContext = getPluginRuntimeLoadContext(previousRegistry);
  const recovery = createPluginReloadRecovery(previousRegistry, preparePlugins);

  const cache = createPluginCache();
  const operationId = params.pluginLifecycle?.operationId ?? randomUUID();
  const requestedIds = new Set(params.pluginLifecycle?.pluginIds ?? []);
  const { warnings, recordWarning, recordCleanup, cleanup } = createPluginReloadDiagnostics(log);
  const replacePluginIds = resolvePluginReloadReplacementIds(
    previousRegistry,
    [...requestedIds, ...(params.reloadPluginIds ?? [])],
    params.changedPaths,
  );
  let phase: "prepare" | "drain" | "activate" | "dispose" = "prepare";
  let previousStopStarted = false;
  let previousHooksStopped = false;
  let previousCleanupFailed = false;
  let committed = false;
  let restored = false;
  let candidateServices: PluginServicesHandle | undefined;
  let loaded: ReturnType<typeof prepareGatewayPluginLoad> | undefined;
  let decisionReplacement: ReturnType<typeof prepareDecisionProviderReload> | undefined;
  let memoryReplacement: ReturnType<typeof prepareMemoryRuntimeReload> | undefined;
  const changedPluginIds = new Set(replacePluginIds);
  let resourceHandoffIds = new Set<string>();
  const sidecarReplacements: ReturnType<
    NonNullable<GatewayPostReadySidecarHandle["preparePluginReload"]>
  >[] = [];
  const quiescedInstances: PluginInstanceHandle[] = [];
  let rollbackConfigEffects: (() => Promise<void>) | undefined;
  let releaseResourceHandoff: (() => void) | undefined;
  const skipChannels =
    isTruthyEnvValue(params.env?.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(params.env?.OPENCLAW_SKIP_PROVIDERS);
  const channels = createPluginReloadChannels({
    channelManager,
    previousRegistry,
    skipChannels,
    previousStopStarted: () => previousStopStarted,
    reloadParams: params,
    ambientEnvTriggers,
  });
  const { channelTargets, startReplacedChannels, releaseChannelHandoffs } = channels;
  const {
    attempt,
    stopPreviousServices,
    isBlockingStopError,
    rethrowServiceStopTimeout,
    includeServiceStopFailure,
    reserveResourceHandoff,
    selectResourceHandoff,
    drainInstances,
    drainBeforeReplacement,
    drainForRecovery,
    disposeInstances,
    runLifecycleHooks,
    prepareRegistrationFailureCleanup,
    retireUnpublished,
  } = createPluginReloadCleanup({
    previousRegistry,
    changedPluginIds,
    port,
    pluginWorkspaceDir,
    log,
    // SAFETY: Gateway cron implements the SDK hook surface, which erases core-only job fields.
    getCron: kernel.getCronService as () => PluginHookGatewayCronService,
    recordCleanup,
    retainRetirement: (retire) => kernel.pluginMetadata.retire(cache, retire),
  });
  const replacement = kernel.pluginRuntimeGeneration.reserve();
  const assertCurrent = () => {
    params.assertInvokerOwned?.();
    if (params.isAborted?.()) {
      throw new GatewayConfigReloadSupersededError();
    }
  };
  try {
    await params.checkpoint?.();
    assertCurrent();
    recordCleanup(
      await withPluginHostCleanupTimeout("pending plugin retirement", () =>
        kernel.pluginMetadata.waitForRetirement(),
      ),
    );
    await params.checkpoint?.();
    assertCurrent();
    // Refresh this operation's cache while retaining the durable ledger of installed package roots.
    const nextMetadata = withPluginCache(cache, () =>
      loadPluginMetadataSnapshot({
        config: params.sourceConfig,
        workspaceDir: pluginWorkspaceDir,
        env: params.env,
        allowCurrent: false,
      }),
    );
    const activationConfig = resolveGatewayStartupPluginActivationConfig({
      runtimeConfig: params.nextConfig,
      activationSourceConfig: params.sourceConfig,
      env: params.env,
      manifestRegistry: nextMetadata.manifestRegistry,
      discovery: nextMetadata.discovery,
      ambientEnvTriggers,
    });
    const lookup = withPluginCache(cache, () =>
      loadPluginLookUpTable({
        config: activationConfig,
        workspaceDir: pluginWorkspaceDir,
        env: params.env,
        activationSourceConfig: params.sourceConfig,
        metadataSnapshot: nextMetadata,
        workerProviderIds: workerEnvironmentStartup?.listDurableProviderIds() ?? [],
        ambientEnvTriggers,
      }),
    );
    const loadParams = {
      cfg: params.nextConfig,
      activationSourceConfig: params.sourceConfig,
      workspaceDir: pluginWorkspaceDir,
      log,
      coreGatewayMethodNames,
      hostServices: pluginHostServices,
      baseMethods,
      pluginLookUpTable: lookup,
      pluginMetadataSnapshot: nextMetadata,
      ambientEnvTriggers,
      resolveGatewayContext: resolvePluginGatewayContext,
      loadIntent: "replacement" as const,
      previousRegistry,
      replacePluginIds,
      expectedSourceDigests: params.pluginLifecycle?.expectedSourceDigests,
      prepareRegistrationFailureCleanup: prepareRegistrationFailureCleanup(params.nextConfig),
      env: params.env,
    };
    const preflight = withPluginCache(cache, () =>
      preparePlugins({ ...loadParams, loadModules: false }),
    );
    preflight.retireGatewayRuntimeBindings();
    let nextRegistry = preflight.pluginRegistry;
    resourceHandoffIds = selectResourceHandoff(nextRegistry, requestedIds);
    channels.collectTargets(nextRegistry, changedPluginIds);
    recovery.capture(changedPluginIds);
    await params.checkpoint?.();
    assertCurrent();
    // No yield between the final work check, admission fence, and invalidation.
    releaseResourceHandoff = reserveResourceHandoff(resourceHandoffIds);
    rollbackConfigEffects = params.prepareConfigEffects({
      pluginIds: changedPluginIds,
      channels: channelTargets,
    });
    phase = "drain";
    replacement.setReloadStatus({ phase: "reloading", pluginIds: [...changedPluginIds] });
    channels.pause();
    decisionReplacement = prepareDecisionProviderReload(previousRegistry, changedPluginIds);
    for (const sidecar of runtimeState.gatewayLifetimeSidecars.snapshot()) {
      const prepared = sidecar.preparePluginReload?.({
        previousRegistry,
        nextRegistry,
        changedPluginIds,
        nextConfig: params.nextConfig,
      });
      // Retain each admission fence before another preparation can fail.
      if (prepared) {
        sidecarReplacements.push(prepared);
      }
    }
    memoryReplacement = prepareMemoryRuntimeReload(previousRegistry, nextRegistry);
    // Consumers release their handles while the producing instance is callable.
    for (const sidecar of sidecarReplacements) {
      await sidecar.drain();
    }
    try {
      const result = await memoryReplacement.drain();
      for (const error of result.errors) {
        const warning = `Memory cleanup failed: ${formatErrorMessage(error)}`;
        log.warn(warning);
        recordWarning(warning);
      }
    } catch (error) {
      if (!(error instanceof PluginHostCleanupTimeoutError)) {
        throw error;
      }
      log.warn(error.message);
      recordWarning(error.message);
    }
    await runtimeState.discovery?.update({
      gatewayDiscoveryServices: previousRegistry.gatewayDiscoveryServices.filter(
        (entry) => !changedPluginIds.has(entry.pluginId),
      ),
    });
    for (const record of previousRegistry.plugins) {
      if (changedPluginIds.has(record.id)) {
        const instance = getPluginInstance(record);
        if (instance?.quiesce()) {
          quiescedInstances.push(instance);
        }
      }
    }
    try {
      await drainBeforeReplacement(
        resourceHandoffIds,
        restartDrainSignal,
        replacement.setReloadStatus,
      );
    } catch (error) {
      if (error instanceof PluginHostCleanupTimeoutError) {
        throw new PluginAdmittedWorkTimeoutError(resourceHandoffIds, error);
      }
      throw error;
    }
    assertCurrent();
    replacement.setReloadStatus({ phase: "reloading", pluginIds: [...changedPluginIds] });
    // Channel monitors and services hold long-lived consumers until stop cancels
    // their loops. Ask those owners to stop before joining the remaining work.
    previousStopStarted = true;
    const stopErrors: unknown[] = [];
    const stopOwner = (strict: boolean, label: string, run: () => Promise<void>) =>
      strict ? attempt(stopErrors, run) : cleanup(label, run);
    await channels.stopPrevious(resourceHandoffIds, stopErrors, cleanup);
    await stopOwner(resourceHandoffIds.size > 0, "Plugin service cleanup failed", () =>
      stopPreviousServices(previousServices, resourceHandoffIds.size > 0),
    );
    // Finish admitted work before legacy stop hooks can close shared connections.
    // Removal has no replacement to protect and keeps its bounded, deferred cleanup.
    previousCleanupFailed = stopErrors.some(isBlockingStopError);
    await drainInstances(previousRegistry, resourceHandoffIds);
    rethrowServiceStopTimeout();
    previousHooksStopped = true;
    await stopOwner(resourceHandoffIds.size > 0, "Plugin stop hook failed", () =>
      runLifecycleHooks(previousRegistry, false, previousConfig, recovery.previousHookIds),
    );
    await attempt(stopErrors, () => disposeInstances(previousRegistry, resourceHandoffIds));
    if (stopErrors.length) {
      previousCleanupFailed = true;
      throw new AggregateError(
        stopErrors,
        `Previous plugin cleanup failed; automatic recovery could not safely start: ${stopErrors.map(formatErrorMessage).join("; ")}`,
      );
    }
    await params.checkpoint?.();
    assertCurrent();
    phase = "activate";
    loaded = withPluginCache(cache, () => preparePlugins(loadParams));
    nextRegistry = loaded.pluginRegistry;
    const { resolvedConfig } = loaded;
    const attached = await prepareAttachedPluginRuntime(loaded);
    const publishMetadata = prepareGatewayPluginMetadataSnapshotPublication(nextMetadata, {
      config: params.nextConfig,
      compatibleConfigs: [params.sourceConfig, activationConfig],
      env: params.env,
      workspaceDir: pluginWorkspaceDir,
    });
    const surfaces = withCoreCanvasNodeCapability(
      listPluginNodeCapabilities(nextRegistry),
      isCoreCanvasHostEnabled(params.nextConfig),
    );
    const indexedSurfaces = indexPluginNodeCapabilitySurfaces(surfaces);
    withPluginRegistryPreparationScope(nextRegistry, () =>
      withPluginRuntimeRegistryScope(nextRegistry, () =>
        validateConfiguredBindings(resolvedConfig),
      ),
    );
    await channels.stopAdditional(nextRegistry, changedPluginIds);
    await params.checkpoint?.();
    assertCurrent();
    phase = "activate";
    const startedServices = await withPluginRegistryPreparationScope(nextRegistry, () =>
      startPluginServices({
        registry: nextRegistry,
        config: params.nextConfig,
        workspaceDir: pluginWorkspaceDir,
        broadcastPluginEvent,
        getCronService: kernel.getCronService,
        previous: previousServices,
        onHandle: (handle) => {
          candidateServices = handle;
        },
        throwOnStartError: true,
      }),
    );
    await params.checkpoint?.();
    assertCurrent();
    // Publication owns every independent activation tail, even when an earlier one fails.
    const activationErrors: unknown[] = [];
    try {
      await params.commitRuntime({
        publish: () => {
          assertCurrent();
          // Capture current connections without an await before selection. Credential
          // preparation may reject; after activation only prepared state is published.
          const publishCapabilities = [...clients].map((client) =>
            prepareClientPluginNodeCapabilities({
              client,
              surfaces,
              changedPluginIds,
              ...(client.connect.role === "node"
                ? { allowedSurfaces: new Set(client.connect.caps ?? []) }
                : {}),
            }),
          );
          attached.publish();
          kernel.pluginMetadata.publish(nextMetadata, changedPluginIds, (options) =>
            waitForPluginRegistryRetirement(previousRegistry, options),
          );
          publishMetadata();
          runtime.pluginMetadataSnapshot = nextMetadata;
          replacement.commit();
          kernel.pluginRuntimeGeneration.publishServices(replacement.claim, startedServices);
          // Compare handshake descriptors before the prepared credentials replace them.
          // Changed nodes stay invalidated while their connections close.
          for (const client of clients) {
            reconcileClientPluginNodeCapabilities(client, indexedSurfaces);
          }
          for (const publish of publishCapabilities) {
            publish();
          }
          committed = true;
          channels.release("published");
        },
        afterCommit: () => {
          try {
            broadcast(
              "plugins.changed",
              { generation: getPluginRegistryVersion(nextRegistry) },
              { dropIfSlow: true },
            );
          } catch (error) {
            activationErrors.push(error);
          }
          attached.afterCommit();
        },
      });
    } catch (error) {
      if (!committed) {
        throw error;
      }
      activationErrors.push(error);
    }
    if (committed) {
      await attempt(activationErrors, () => memoryReplacement!.commit(nextRegistry));
      for (const sidecar of sidecarReplacements) {
        await attempt(activationErrors, () => sidecar.resume(params.nextConfig));
      }
      await attempt(activationErrors, () =>
        runtimeState.discovery?.update(
          { gatewayDiscoveryServices: nextRegistry.gatewayDiscoveryServices },
          replacement.claim,
        ),
      );
    }
    await attempt(activationErrors, () => runLifecycleHooks(nextRegistry, true, params.nextConfig));
    await attempt(activationErrors, () =>
      channels.startPublishedChannels(
        nextRegistry,
        activationErrors,
        nextMetadata.manifestRegistry.plugins,
      ),
    );
    if (activationErrors.length > 0) {
      throw activationErrors.length === 1
        ? activationErrors[0]
        : new AggregateError(activationErrors, activationErrors.map(formatErrorMessage).join("; "));
    }
    phase = "dispose";
    recordCleanup(
      await waitForPluginRegistryRetirement(previousRegistry, { deferConsumers: true }),
    );
    recordCleanup(await kernel.pluginMetadata.waitForRetirement());
    const sourceDigests = Object.fromEntries(
      nextRegistry.plugins.flatMap((record) => {
        const digest = getPluginInstance(record)?.sourceDigest;
        return digest && changedPluginIds.has(record.id) ? [[record.id, digest]] : [];
      }),
    );
    const receipt = {
      operationId,
      generation: getPluginRuntimeGeneration(),
      pluginIds: [...changedPluginIds].toSorted(),
      sourceDigests,
      ...(warnings.size ? { warnings: [...warnings] } : {}),
    };
    return {
      activeChannels: new Set(nextRegistry.channels.map((entry) => entry.plugin.id)),
      runtime: receipt,
    };
  } catch (error) {
    let failure = includeServiceStopFailure(error);
    const onCleanupFailure = (message: string) => (cleanupError: unknown) => {
      failure = new AggregateError([failure, cleanupError], message);
    };
    replacement.reject();
    if (!committed) {
      const candidateRegistry =
        loaded?.pluginRegistry ??
        (error instanceof PluginLoadFailureError ? error.registry : undefined);
      let candidateCleanupFailed = false;
      if (candidateServices) {
        // Retained services moved here; shutdown owns them even if recovery cannot run.
        kernel.pluginRuntimeGeneration.publishServices(
          kernel.pluginRuntimeGeneration.currentClaim(),
          candidateServices,
        );
      }
      if (candidateRegistry) {
        try {
          await retireUnpublished(candidateRegistry, params.nextConfig, candidateServices);
        } catch (cleanupError) {
          candidateCleanupFailed = true;
          onCleanupFailure(
            "Plugin candidate cleanup failed; automatic recovery could not safely start",
          )(cleanupError);
        }
      }
      loaded?.retireGatewayRuntimeBindings();
      if (candidateRegistry) {
        await withPluginHostCleanupTimeout("plugin candidate retirement", () =>
          kernel.pluginMetadata.waitForRetirement(),
        )
          .then(recordCleanup)
          .catch(onCleanupFailure("Plugin candidate cleanup failed"));
      } else {
        await retirePluginCache(cache).catch(
          onCleanupFailure("Plugin candidate cache cleanup failed"),
        );
      }
      // A pending signal blocks recovery work until delivery settles; suspension
      // must let this admitted reload finish. Only one-way drain owns teardown.
      if (phase !== "prepare") {
        await waitForGatewayRestartFenceSettlement();
      }
      if (
        phase !== "prepare" &&
        !restartDrainSignal.aborted &&
        !candidateCleanupFailed &&
        !previousCleanupFailed
      ) {
        const recoveryErrors: unknown[] = [];
        let recovered: ReturnType<typeof prepareGatewayPluginLoad> | undefined;
        let recoveredServices: PluginServicesHandle | undefined;
        let recoveryPublished = false;
        try {
          let restoredRegistry = previousRegistry;
          if (previousStopStarted) {
            // Stop is not reversible for all plugins (for example, aborted controllers).
            // Re-register captured old code instead of reopening a stopped registration.
            await drainForRecovery(restartDrainSignal, replacement.setReloadStatus);
            if (!previousHooksStopped) {
              previousHooksStopped = true;
              await runLifecycleHooks(
                previousRegistry,
                false,
                previousConfig,
                recovery.previousHookIds,
              );
            }
            await disposeInstances(previousRegistry, changedPluginIds);
            recovered = recovery.prepare(
              {
                cfg: previousConfig,
                activationSourceConfig:
                  previousLoadContext?.activationSourceConfig ?? previousConfig,
                workspaceDir: pluginWorkspaceDir,
                log,
                coreGatewayMethodNames,
                hostServices: pluginHostServices,
                baseMethods,
                pluginMetadataSnapshot: previousMetadata,
                ambientEnvTriggers,
                resolveGatewayContext: resolvePluginGatewayContext,
                loadIntent: "replacement",
                previousRegistry,
                replacePluginIds: changedPluginIds,
                prepareRegistrationFailureCleanup:
                  prepareRegistrationFailureCleanup(previousConfig),
                env: previousLoadContext?.env ?? params.env,
              },
              error,
            );
            restoredRegistry = recovered.pluginRegistry;
            const attached = await prepareAttachedPluginRuntime(recovered);
            await withPluginRegistryPreparationScope(restoredRegistry, async () => {
              await attempt(recoveryErrors, async () => {
                await startPluginServices({
                  registry: restoredRegistry,
                  config: previousConfig,
                  workspaceDir: pluginWorkspaceDir,
                  broadcastPluginEvent,
                  getCronService: kernel.getCronService,
                  previous: kernel.pluginRuntimeGeneration.currentServices(),
                  onHandle: (handle) => {
                    recoveredServices = handle;
                    kernel.pluginRuntimeGeneration.publishServices(
                      kernel.pluginRuntimeGeneration.currentClaim(),
                      handle,
                    );
                  },
                  throwOnStartError: true,
                });
              });
              attached.publish();
              recoveryPublished = true;
              attached.afterCommit();
            });
            await attempt(recoveryErrors, () => memoryReplacement?.commit(restoredRegistry));
            broadcast(
              "plugins.changed",
              { generation: getPluginRegistryVersion(restoredRegistry) },
              { dropIfSlow: true },
            );
          } else {
            // Restored preparation must be able to retain the still-callable instances.
            releaseResourceHandoff?.();
            for (const instance of quiescedInstances) {
              instance.resume();
            }
            await attempt(recoveryErrors, () => memoryReplacement?.rollback());
          }
          for (const sidecar of sidecarReplacements) {
            await attempt(recoveryErrors, () => sidecar.resume(previousConfig));
          }
          await attempt(recoveryErrors, () =>
            runtimeState.discovery?.update(
              { gatewayDiscoveryServices: restoredRegistry.gatewayDiscoveryServices },
              kernel.pluginRuntimeGeneration.currentClaim(),
            ),
          );
          // Early drain failures restore pauses without restarting hooks that never stopped.
          if (previousStopStarted) {
            await attempt(recoveryErrors, () =>
              runLifecycleHooks(restoredRegistry, true, previousConfig),
            );
          }
          if (recoveryErrors.length === 0) {
            if (!previousStopStarted) {
              await decisionReplacement?.rollback(restartDrainSignal);
            }
            channels.release("rollback");
            await startReplacedChannels(restoredRegistry, recoveryErrors);
          }
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
          const failedRecoveryRegistry =
            recovered?.pluginRegistry ??
            (recoveryError instanceof PluginLoadFailureError ? recoveryError.registry : undefined);
          if (!recoveryPublished && failedRecoveryRegistry) {
            await attempt(recoveryErrors, () =>
              retireUnpublished(failedRecoveryRegistry, previousConfig, recoveredServices),
            );
            recovered?.retireGatewayRuntimeBindings();
            await attempt(recoveryErrors, async () => {
              recordCleanup(
                await withPluginHostCleanupTimeout("plugin recovery retirement", () =>
                  kernel.pluginMetadata.waitForRetirement(),
                ),
              );
            });
          }
        } finally {
          await releaseChannelHandoffs(recoveryErrors);
        }
        restored = recoveryErrors.length === 0;
        if (recoveryErrors.length > 0) {
          const recoveryError =
            recoveryErrors.length === 1
              ? recoveryErrors[0]
              : new AggregateError(
                  recoveryErrors,
                  recoveryErrors.map(formatErrorMessage).join("; "),
                );
          failure = new AggregateError(
            [failure, recoveryError],
            "Plugin replacement failed and its previous instance could not be restored.",
          );
        }
      }
      if (phase !== "prepare" && !restartDrainSignal.aborted) {
        const retainedChannelErrors: unknown[] = [];
        await channels.restoreUnchanged(changedPluginIds, retainedChannelErrors);
        if (retainedChannelErrors.length) {
          failure = new AggregateError(
            [failure, ...retainedChannelErrors],
            "Plugin replacement failed and an unchanged channel could not resume.",
          );
        }
        try {
          await rollbackConfigEffects?.();
        } catch (rollbackError) {
          restored = false;
          onCleanupFailure("Plugin runtime rollback could not republish the model runtime")(
            rollbackError,
          );
        }
      }
    } else {
      await kernel.pluginMetadata
        .waitForRetirement()
        .catch(onCleanupFailure("Previous plugin cache cleanup failed"));
    }
    throw new PluginRuntimeApplicationError(
      `Plugin operation failed during ${phase}: ${formatErrorMessage(failure)}`,
      {
        operationId,
        generation: getPluginRuntimeGeneration(),
        pluginIds: [...changedPluginIds].toSorted(),
        phase,
        committed,
      },
      { cause: failure },
    );
  } finally {
    releaseResourceHandoff?.();
    // A completed operation never retains an in-progress channel pause. Failed
    // instances keep their own resource/admission fence until a later safe reload.
    channels.release("failed");
    const activated = phase === "dispose";
    replacement.finishReload(
      activated ? "applied" : restored ? "restored" : phase === "prepare" ? "unchanged" : "failed",
      changedPluginIds,
      pluginRuntime.registry,
      restartDrainSignal.aborted ? undefined : log.error,
    );
    recovery.dispose();
  }
}
