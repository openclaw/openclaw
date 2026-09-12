import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { withCoreCanvasNodeCapability } from "../canvas/constants.js";
import { validateConfiguredBindings } from "../channels/plugins/configured-binding-registry.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { listAmbientOnlyConfiguredChannelIds } from "../plugins/channel-presence-policy.js";
import { prepareGatewayPluginMetadataSnapshotPublication } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import { createHookRunner } from "../plugins/hooks.js";
import { PluginHostCleanupTimeoutError } from "../plugins/host-hook-cleanup-timeout.js";
import type { PluginHostCleanupResult } from "../plugins/host-hook-cleanup.types.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { PluginLoadFailureError } from "../plugins/loader-shared.js";
import { prepareMemoryRuntimeReload } from "../plugins/memory-runtime.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRegistryPreparationScope } from "../plugins/registry-lifecycle.js";
import { getPluginRegistryVersion } from "../plugins/runtime-state.js";
import {
  disposePluginRegistryInstances,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  startPluginServices,
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  type PluginServicesHandle,
} from "../plugins/services.js";
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

  const cache = createPluginCache();
  const operationId = params.pluginLifecycle?.operationId ?? randomUUID();
  const requestedIds = new Set(params.pluginLifecycle?.pluginIds ?? []);
  const warnings = new Set<string>();
  const recordWarning = (warning: string) => {
    // Keep tool/RPC results bounded; complete cleanup diagnostics remain in the log.
    if (warnings.size < 8) {
      warnings.add(truncateUtf16Safe(warning, 240));
    } else {
      warnings.add("Additional plugin cleanup warnings were recorded in the Gateway log.");
    }
  };
  const recordCleanup = (result: PluginHostCleanupResult) => {
    for (const pluginId of result.deferredPluginIds ?? []) {
      const warning = `Plugin ${pluginId} cleanup is deferred until its admitted work finishes.`;
      log.info(warning);
      recordWarning(warning);
    }
    for (const failure of result.failures) {
      recordWarning(
        `Plugin ${failure.pluginId} cleanup failed (${failure.hookId}): ${formatErrorMessage(failure.error)}`,
      );
    }
  };
  const cleanup = async (label: string, run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      const warning = `${label}: ${formatErrorMessage(error)}`;
      log.warn(warning);
      recordWarning(warning);
    }
  };
  const attempt = async (errors: unknown[], run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const replacePluginIds = new Set(requestedIds);
  for (const record of previousRegistry.plugins) {
    if (
      params.changedPaths.some(
        (key) =>
          key === `plugins.entries.${record.id}` ||
          key.startsWith(`plugins.entries.${record.id}.`) ||
          key === `plugins.installs.${record.id}` ||
          key.startsWith(`plugins.installs.${record.id}.`),
      )
    ) {
      replacePluginIds.add(record.id);
    }
  }
  let phase: "prepare" | "drain" | "activate" | "dispose" = "prepare";
  let previousStopStarted = false;
  let committed = false;
  let candidateServices: PluginServicesHandle | undefined;
  let loaded: ReturnType<typeof prepareGatewayPluginLoad> | undefined;
  let memoryReplacement: ReturnType<typeof prepareMemoryRuntimeReload> | undefined;
  let changedPluginIds = new Set(replacePluginIds);
  const sidecarReplacements: ReturnType<
    NonNullable<GatewayPostReadySidecarHandle["preparePluginReload"]>
  >[] = [];
  let releaseChannelStarts: ReturnType<typeof channelManager.pauseChannelStarts> | undefined;
  const channelTargets = new Set<ChannelId>();
  const quiescedInstances: PluginInstanceHandle[] = [];
  const skipChannels =
    isTruthyEnvValue(params.env?.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(params.env?.OPENCLAW_SKIP_PROVIDERS);
  const stopReplacedServices = (services: PluginServicesHandle | null | undefined) =>
    cleanup("Plugin service cleanup failed", async () => {
      await services?.stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        pluginIds: changedPluginIds,
      });
    });
  const startReplacedChannels = async (registry: typeof previousRegistry, errors: unknown[]) => {
    for (const { plugin } of registry.channels) {
      if (skipChannels || !channelTargets.has(plugin.id)) {
        continue;
      }
      await attempt(errors, async () => {
        // Whole-channel targets include preparation that had not reserved an account at drain.
        const result = await channelManager.startChannel(plugin.id, undefined, {
          manual: false,
          preserveManualStop: true,
          skipUnavailableAccounts: true,
        });
        // Early rollback can retain a live account behind the public task-owned outcome.
        const failures = [...result].filter(
          ([accountId, outcome]) =>
            outcome.status === "retry" &&
            (previousStopStarted ||
              outcome.reason !== "task-owned" ||
              !channelManager.hasCurrentAccountTask(plugin.id, accountId)),
        );
        if (failures.length) {
          throw new Error(
            `Plugin channel ${plugin.id} could not start: ${failures.map(([id]) => id).join(", ")}`,
          );
        }
      });
    }
  };
  const releaseChannelHandoffs = async (errors: unknown[]) => {
    for (const channelId of channelTargets) {
      // The manager keeps handoffs already admitted by successful accounts.
      await attempt(errors, () => channelManager.releaseChannelRouteHandoffs(channelId));
    }
  };
  const runLifecycleHooks = async (
    registry: typeof previousRegistry,
    start: boolean,
    config: typeof previousConfig,
  ) => {
    const hooks = createHookRunner(
      {
        ...registry,
        typedHooks: registry.typedHooks.filter((hook) => changedPluginIds.has(hook.pluginId)),
      },
      {
        logger: log,
        catchErrors: false,
        voidHookTimeoutMsByHook: {
          gateway_start: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          gateway_stop: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        },
      },
    );
    const context = {
      port,
      config,
      workspaceDir: pluginWorkspaceDir,
      // SAFETY: Gateway cron implements the SDK hook surface, which erases core-only job fields.
      getCron: () => runtimeState.cronState.cron as PluginHookGatewayCronService,
    };
    await withPluginHttpRouteRegistry(registry, () =>
      start
        ? hooks.runGatewayStart({ port }, context)
        : hooks.runGatewayStop({ reason: "plugin replacement" }, context),
    );
  };
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
    recordCleanup(await kernel.pluginMetadata.waitForRetirement());
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
    loaded = withPluginCache(cache, () =>
      preparePlugins({
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
        loadIntent: "replacement",
        previousRegistry,
        replacePluginIds,
        expectedSourceDigests: params.pluginLifecycle?.expectedSourceDigests,
        env: params.env,
      }),
    );
    const { pluginRegistry: nextRegistry, resolvedConfig } = loaded;
    const retainedRecords = new Set(nextRegistry.plugins);
    changedPluginIds = new Set([
      ...requestedIds,
      ...previousRegistry.plugins
        .filter((record) => !retainedRecords.has(record))
        .map((record) => record.id),
      ...nextRegistry.plugins
        .filter((record) => !previousRegistry.plugins.includes(record))
        .map((record) => record.id),
    ]);
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
    if (
      previousRegistry.commands.some((entry) => !nextRegistry.commands.includes(entry)) ||
      nextRegistry.commands.some((entry) => !previousRegistry.commands.includes(entry))
    ) {
      // Pending starts can retain commands before their first catalog read.
      for (const channel of previousRegistry.channels) {
        channelTargets.add(channel.plugin.id);
      }
    }
    for (const channel of [...previousRegistry.channels, ...nextRegistry.channels]) {
      if (changedPluginIds.has(channel.pluginId)) {
        channelTargets.add(channel.plugin.id);
      }
    }
    await params.checkpoint?.();
    assertCurrent();
    params.prepareConfigEffects({ pluginIds: changedPluginIds, channels: channelTargets });
    releaseChannelStarts = channelManager.pauseChannelStarts(channelTargets);
    phase = "drain";
    for (const sidecar of runtimeState.gatewayLifetimeSidecars) {
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
    previousStopStarted = true;
    await cleanup("Plugin stop hook failed", () =>
      runLifecycleHooks(previousRegistry, false, previousConfig),
    );
    for (const { plugin } of previousRegistry.channels) {
      if (!channelTargets.has(plugin.id)) {
        continue;
      }
      await cleanup(`Plugin channel ${plugin.id} cleanup failed`, () =>
        channelManager.stopChannel(plugin.id, undefined, {
          manual: false,
          strict: true,
          routeHandoff: true,
        }),
      );
    }
    await stopReplacedServices(previousServices);
    for (const record of previousRegistry.plugins) {
      if (changedPluginIds.has(record.id)) {
        const result = await getPluginInstance(record)?.drain();
        for (const error of result?.errors ?? []) {
          const warning = `Plugin ${record.id} drain failed: ${formatErrorMessage(error)}`;
          log.warn(warning);
          recordWarning(warning);
        }
      }
    }
    await params.checkpoint?.();
    assertCurrent();
    phase = "activate";
    const startedServices = await withPluginRegistryPreparationScope(nextRegistry, () =>
      startPluginServices({
        registry: nextRegistry,
        config: params.nextConfig,
        workspaceDir: pluginWorkspaceDir,
        broadcastPluginEvent,
        getCronService: () => runtimeState.cronState.cron,
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
          releaseChannelStarts?.("published");
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
      await attempt(activationErrors, memoryReplacement.commit);
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
    await attempt(activationErrors, async () => {
      try {
        channelManager.setAmbientAutostartSuppressedChannelIds(
          ambientEnvTriggers === "suppress"
            ? new Set(
                listAmbientOnlyConfiguredChannelIds({
                  config: params.nextConfig,
                  activationSourceConfig: params.sourceConfig,
                  env: params.env,
                  includePersistedAuthState: false,
                  manifestRecords: nextMetadata.manifestRegistry.plugins,
                }),
              )
            : new Set(),
        );
        await startReplacedChannels(nextRegistry, activationErrors);
      } finally {
        await releaseChannelHandoffs(activationErrors);
      }
    });
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
    let failure = error;
    const onCleanupFailure = (message: string) => (cleanupError: unknown) => {
      failure = new AggregateError([failure, cleanupError], message);
    };
    replacement.reject();
    if (!committed) {
      const candidateRegistry =
        loaded?.pluginRegistry ??
        (error instanceof PluginLoadFailureError ? error.registry : undefined);
      for (const record of candidateRegistry?.plugins ?? []) {
        if (!previousRegistry.plugins.includes(record)) {
          getPluginInstance(record)?.quiesce();
        }
      }
      if (candidateServices) {
        // Retained services already moved here; shutdown must own them even if recovery is skipped.
        kernel.pluginRuntimeGeneration.publishServices(
          kernel.pluginRuntimeGeneration.currentClaim(),
          candidateServices,
        );
        await stopReplacedServices(candidateServices);
      }
      loaded?.retireGatewayRuntimeBindings();
      if (candidateRegistry) {
        void disposePluginRegistryInstances(candidateRegistry, previousRegistry).catch(() => {});
        // Rejected candidates keep the same physical cleanup owner as replaced generations.
        kernel.pluginMetadata.retire(cache, (options) =>
          waitForPluginRegistryRetirement(candidateRegistry, options),
        );
        await kernel.pluginMetadata
          .waitForRetirement()
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
      if (phase !== "prepare" && !restartDrainSignal.aborted) {
        const recoveryErrors: unknown[] = [];
        try {
          for (const instance of quiescedInstances) {
            instance.resume();
          }
          await attempt(recoveryErrors, () => memoryReplacement?.rollback());
          await attempt(recoveryErrors, async () => {
            await startPluginServices({
              registry: previousRegistry,
              config: previousConfig,
              workspaceDir: pluginWorkspaceDir,
              broadcastPluginEvent,
              getCronService: () => runtimeState.cronState.cron,
              previous: kernel.pluginRuntimeGeneration.currentServices(),
              onHandle: (handle) => {
                kernel.pluginRuntimeGeneration.publishServices(
                  kernel.pluginRuntimeGeneration.currentClaim(),
                  handle,
                );
              },
              throwOnStartError: true,
            });
          });
          for (const sidecar of sidecarReplacements) {
            await attempt(recoveryErrors, () => sidecar.resume(previousConfig));
          }
          await attempt(recoveryErrors, () =>
            runtimeState.discovery?.update(
              { gatewayDiscoveryServices: previousRegistry.gatewayDiscoveryServices },
              kernel.pluginRuntimeGeneration.currentClaim(),
            ),
          );
          // Early drain failures restore pauses without restarting hooks that never stopped.
          if (previousStopStarted) {
            await attempt(recoveryErrors, () =>
              runLifecycleHooks(previousRegistry, true, previousConfig),
            );
          }
          if (recoveryErrors.length === 0) {
            // Clear every independent pause, but reopen channel admission only after restoration.
            releaseChannelStarts?.("rollback");
            await startReplacedChannels(previousRegistry, recoveryErrors);
          }
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        } finally {
          await releaseChannelHandoffs(recoveryErrors);
        }
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
  }
}
