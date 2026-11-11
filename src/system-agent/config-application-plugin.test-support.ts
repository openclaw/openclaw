import assert from "node:assert/strict";
import { vi } from "vitest";
import { makeModel } from "../agents/embedded-agent-runner/model.test-harness.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
} from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import type { PreparedModelRuntimeLease } from "../agents/prepared-model-runtime.types.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bootstrap from "../gateway/server-plugin-bootstrap.js";
import { reloadGatewayPlugins } from "../gateway/server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "../gateway/server-plugin-runtime-generation.js";
import { refreshModelRuntimeAfterHotReload } from "../gateway/server-reload-model-runtime-scope.js";
import { GatewayRequestEntryLifetime } from "../gateway/server-request-entry.js";
import { createGatewaySidecarStopOwner } from "../gateway/server-sidecar-owners.js";
import { publishConfiguredModelRuntimeSnapshots } from "../gateway/server-startup-model-runtime.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { retainGatewayPluginMetadata } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginRegistryOwner } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServicesHandle } from "../plugins/services.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

// Real loader/publication fixture following server-plugin-reload.prepared-borrow.test.ts.
// The declared fixture model is used for preparation only; this helper never calls inference.
export function setupReloadModelConfig(
  workspace: string,
): Pick<OpenClawConfig, "agents" | "models"> {
  const fixture = {
    baseUrl: "https://fixture.invalid/v1",
    api: "openai-completions" as const,
    agentRuntime: { id: "openclaw" },
    models: [{ ...makeModel("probe"), name: "Probe", contextWindow: 32000, maxTokens: 1024 }],
  };
  return {
    agents: { ownership: "explicit", entries: { main: { workspace, model: "fixture/probe" } } },
    models: { mode: "replace", providers: { fixture } },
  };
}

export async function createSetupReloadPluginFixture(
  state: OpenClawTestState,
  config: OpenClawConfig,
  onInfo: (message: string) => void = () => {},
) {
  const { workspaceDir } = state;
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  let services: PluginServicesHandle | null = null;
  const env = process.env;
  const logs = { info: vi.fn(onInfo), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const log = { ...createSubsystemLogger("gateway/plugins"), ...logs };
  const metadataSnapshot = await resolveConfigWidePluginMetadataSnapshotAsync({
    config,
    env,
  });
  const initial = await bootstrap.prepareGatewayPluginLoad({
    pluginMetadataSnapshot: metadataSnapshot,
    pluginLookUpTable: loadPluginLookUpTable({
      config,
      workspaceDir,
      env,
      metadataSnapshot,
      ambientEnvTriggers: "suppress",
    }),
    cfg: config,
    workspaceDir,
    env,
    log,
    baseMethods: [],
    ambientEnvTriggers: "suppress",
    loadIntent: "startup",
  });
  activatePluginRegistry(initial.pluginRegistry, null, "gateway-bindable", workspaceDir);
  const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, workspaceDir);
  const inRegistry = <T>(run: () => T) =>
    withPluginRuntimeRegistryScope(registryOwner.registry, run);
  const scheduler = createTestGatewayScheduler();
  const metadata = retainGatewayPluginMetadata(scheduler);
  metadata.publish(metadataSnapshot);
  const loaded = [initial];
  const leases = new AsyncDisposableStack();
  const lifetime = createGatewaySidecarStopOwner();
  const runtime = {
    scheduler,
    requestEntryLifetime: new GatewayRequestEntryLifetime(),
    pluginMetadataSnapshot: metadataSnapshot,
    pluginRuntime: registryOwner,
    pluginWorkspaceDir: workspaceDir,
    kernel: {
      pluginRuntimeGeneration: createGatewayPluginRuntimeGeneration({
        getServices: () => services,
        setServices: (handle) => {
          services = handle;
        },
      }),
      pluginMetadata: metadata,
      getCronService: () => undefined,
    },
    runtimeState: { cronState: {}, gatewayLifetimeSidecars: lifetime },
    ambientEnvTriggers: "suppress",
    coreGatewayMethodNames: [],
    baseMethods: [],
    channelManager: {
      pauseChannelStarts: () => () => {},
      setAmbientAutostartSuppressedChannelIds: vi.fn(),
    },
    clients: new Set(),
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];

  const reloadOptions: Parameters<typeof reloadGatewayPlugins>[0] = {
    runtime,
    port: 0,
    log,
    loadGatewayPluginBootstrapModule: async () => bootstrap,
    prepareAttachedPluginRuntime: async (candidate, trackActivationCleanup) => {
      loaded.push(candidate);
      return {
        publish() {
          activatePluginRegistry(
            candidate.pluginRegistry,
            null,
            "gateway-bindable",
            workspaceDir,
            registryOwner.registry,
            trackActivationCleanup,
          );
          registryOwner.publish(candidate.pluginRegistry);
        },
        afterCommit() {},
      };
    },
  };
  return {
    initial,
    registryOwner,
    runtime,
    log,
    reload(
      nextConfig: OpenClawConfig,
      changedPaths: string[],
      pluginLifecycle?: Parameters<typeof reloadGatewayPlugins>[1]["pluginLifecycle"],
      publishConfig?: () => void,
    ) {
      return reloadGatewayPlugins(reloadOptions, {
        nextConfig,
        sourceConfig: nextConfig,
        changedPaths,
        pluginLifecycle,
        env,
        prepareConfigEffects: () => ({
          retire: () =>
            markPreparedModelRuntimeSnapshotsStale("plugin reload", { waitForReplacement: true }),
          rollback: async () => {},
        }),
        commitRuntime: async (publication) => {
          publication?.publish();
          publishConfig?.();
          publication?.afterCommit?.();
        },
      });
    },
    async acquireTurn(
      snapshot?: Awaited<ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>,
    ): Promise<PreparedModelRuntimeLease> {
      const published =
        snapshot ?? (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" }));
      assert(published);
      const lease = leases.use(
        await inRegistry(() =>
          acquireAgentRunPreparedModelRuntime(
            {
              config: published.config,
              agentId: published.agentId,
              agentDir: published.agentDir,
              workspaceDir: published.workspaceDir,
              allowGatewaySubagentBinding: true,
              runtimePluginSelections: [
                { provider: "fixture", modelId: "probe", runtime: "openclaw" },
              ],
            },
            { catalogMode: "static", pluginGeneration: published.pluginGeneration },
          ),
        ),
      );
      // Catalog construction temporarily retains the whole generation independently
      // of the turn. Join that owner before measuring selective tool retention.
      // The fixture provider declares no discovery callback and makes no requests.
      await lease.snapshot.loadFullModelCatalog?.({ refresh: true, wait: true });
      return lease;
    },
    publish: () =>
      inRegistry(() =>
        publishConfiguredModelRuntimeSnapshots({
          cfg: config,
          pluginMetadataSnapshot: metadataSnapshot,
          workspaceDir,
        }),
      ),
    refresh: (nextConfig: OpenClawConfig) =>
      inRegistry(() =>
        refreshModelRuntimeAfterHotReload({
          config: nextConfig,
          agentIds: undefined,
          pluginMetadataSnapshot: runtime.pluginMetadataSnapshot,
        }),
      ),
    tools: (toolName: string, lease?: PreparedModelRuntimeLease, currentConfig = config) =>
      inRegistry(() =>
        resolveOpenClawPluginToolsForOptions({
          resolvedConfig: currentConfig,
          options: {
            config: currentConfig,
            workspaceDir,
            agentSessionKey: "agent:main:main",
            senderIsOwner: true,
            preparedModelRuntime: lease?.snapshot,
            pluginToolAllowlist: [toolName],
            assertInvocationCurrent() {},
          },
        }),
      ),
    async [Symbol.asyncDispose]() {
      await leases.disposeAsync();
      await closePreparedModelRuntimeSnapshots();
      await services?.stop({ strict: true });
      await lifetime.stop();
      loaded.forEach((entry) => entry.retireGatewayRuntimeBindings());
      await registryOwner.close();
      await metadata.close();
      await scheduler.stop();
    },
  };
}
