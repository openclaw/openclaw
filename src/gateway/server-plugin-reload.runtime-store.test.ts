import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
} from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createHookRunner } from "../plugins/hooks.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import {
  clearPluginMetadataLifecycleCaches,
  retainGatewayPluginMetadata,
} from "../plugins/plugin-metadata-lifecycle.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { createAccessPolicyTransport } from "./server-methods/agent.visitor-access.test-support.js";
import * as bootstrap from "./server-plugin-bootstrap.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { refreshModelRuntimeAfterHotReload } from "./server-reload-model-runtime-scope.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";

beforeEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

afterEach(async () => {
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  resetGatewayWorkAdmission();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Protect the service-to-agent-tool contract through the actual replacement loader.
// Existing visitor tests only start an already-enabled plugin; registry recovery
// fixtures substitute their own candidate loader and do not resolve agent tools.
it.each(["cold start", "hot enable"] as const)(
  "%s lets a published agent runtime use the visitor service",
  async (mode) => {
    await withOpenClawTestState({ label: "plugin-hot-runtime-store" }, async (state) => {
      const pluginId = "visitor-access";
      const toolName = "visitor_revoke";
      const bundledDir = fileURLToPath(new URL("../../extensions/", import.meta.url));
      const provider = createAccessPolicyTransport();
      vi.stubGlobal("fetch", provider.fetcher);
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
      vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
      const env = process.env;
      const configFor = (enabled: boolean): OpenClawConfig => ({
        agents: {
          ownership: "explicit",
          entries: { main: { workspace: state.workspaceDir, model: "fixture/probe" } },
        },
        models: {
          mode: "replace",
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid/v1",
              api: "openai-completions",
              agentRuntime: { id: "openclaw" },
              models: [
                {
                  id: "probe",
                  name: "Probe",
                  contextWindow: 32000,
                  maxTokens: 1024,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        plugins: {
          allow: [pluginId],
          slots: { memory: "none" },
          entries: {
            [pluginId]: {
              enabled,
              config: {
                accountId: "test-account",
                appId: "test-app",
                apiToken: "synthetic-visitor-token",
              },
            },
          },
        },
        tools: { allow: [toolName] },
      });
      let config = configFor(mode === "cold start");
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const log = { ...createSubsystemLogger("gateway/plugins"), ...logs };
      const initialMetadata = await resolveConfigWidePluginMetadataSnapshotAsync({ config, env });
      const initial = bootstrap.prepareGatewayPluginLoad({
        pluginMetadataSnapshot: initialMetadata,
        pluginLookUpTable: loadPluginLookUpTable({
          config,
          workspaceDir: state.workspaceDir,
          env,
          metadataSnapshot: initialMetadata,
          ambientEnvTriggers: "suppress",
        }),
        cfg: config,
        workspaceDir: state.workspaceDir,
        env,
        log,
        baseMethods: [],
        ambientEnvTriggers: "suppress",
        loadIntent: "startup",
      });
      activatePluginRegistry(initial.pluginRegistry, null, "gateway-bindable", state.workspaceDir);
      let services: PluginServicesHandle | null = null;
      const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, state.workspaceDir);
      const metadata = retainGatewayPluginMetadata(createTestGatewayScheduler());
      metadata.publish(initialMetadata);
      const loaded = [initial];
      const lifetime = createGatewaySidecarStopOwner();
      const runtime = {
        requestEntryLifetime: new GatewayRequestEntryLifetime(),
        pluginMetadataSnapshot: initialMetadata,
        pluginRuntime: registryOwner,
        pluginWorkspaceDir: state.workspaceDir,
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
      let runLease: Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>> | undefined;
      const resolveTools = () => {
        return withPluginRuntimeRegistryScope(registryOwner.registry, () =>
          resolveOpenClawPluginToolsForOptions({
            resolvedConfig: config,
            options: {
              config,
              workspaceDir: state.workspaceDir,
              agentSessionKey: "agent:main:main",
              senderIsOwner: true,
              preparedModelRuntime: runLease?.snapshot,
              pluginToolAllowlist: [toolName],
              assertInvocationCurrent: () => {},
            },
          }),
        );
      };
      try {
        // Match post-attach startup: publish configured model owners, start services,
        // then deliver gateway_start before admitting the first owner turn.
        await withPluginRuntimeRegistryScope(registryOwner.registry, () =>
          publishConfiguredModelRuntimeSnapshots({
            cfg: config,
            pluginMetadataSnapshot: initialMetadata,
            workspaceDir: state.workspaceDir,
          }),
        );
        services = await startPluginServices({
          registry: initial.pluginRegistry,
          config,
          workspaceDir: state.workspaceDir,
          throwOnStartError: true,
          onHandle: (handle) => {
            services = handle;
          },
        });
        await runGatewayStartupObservers({
          registry: initial.pluginRegistry,
          signal: runtime.requestEntryLifetime.signal,
          port: 0,
          config,
          workspaceDir: state.workspaceDir,
          getCron: () => undefined,
          log,
          logHooks: logs,
          createHookRunner,
          refreshLatestUpdateRestartSentinel: async () => {},
        });
        if (mode === "hot enable") {
          expect(resolveTools()).toEqual([]);
          const nextConfig = configFor(true);
          const changedPaths = [`plugins.entries.${pluginId}.enabled`];
          const plan = buildGatewayReloadPlan(changedPaths, {
            previousConfig: config,
            candidateConfig: nextConfig,
          });
          expect(plan.reloadPlugins).toBe(true);
          expect(plan.restartGateway).toBe(false);
          await state.writeConfig(nextConfig);
          await reloadGatewayPlugins(
            {
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
                      state.workspaceDir,
                      registryOwner.registry,
                      trackActivationCleanup,
                    );
                    registryOwner.publish(candidate.pluginRegistry);
                  },
                  afterCommit() {},
                };
              },
            },
            {
              nextConfig,
              sourceConfig: nextConfig,
              changedPaths,
              prepareConfigEffects: () => ({
                retire: () => {
                  markPreparedModelRuntimeSnapshotsStale(
                    "prepared model runtime owner is stale before plugin replacement",
                    { waitForReplacement: true },
                  );
                },
                rollback: async () => {},
              }),
              env,
              commitRuntime: async (publication) => {
                publication?.publish();
                markPreparedModelRuntimeSnapshotsStale(
                  "prepared model runtime owner is stale before config publication",
                  { waitForReplacement: true },
                );
                config = nextConfig;
                setRuntimeConfigSnapshot(config);
                publication?.afterCommit?.();
              },
            },
          );
          expect(logs.info).toHaveBeenCalledWith(`Plugin replacement applied: ${pluginId}`);
          await withPluginRuntimeRegistryScope(registryOwner.registry, () =>
            refreshModelRuntimeAfterHotReload({
              config,
              agentIds: undefined,
              pluginMetadataSnapshot: runtime.pluginMetadataSnapshot,
            }),
          );
        }
        // Use the published owner and the same acquisition as Gateway agent admission.
        const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        assert(published);
        const record = registryOwner.registry.plugins.find((entry) => entry.id === pluginId);
        assert(record);
        const gatewayInstance = getPluginInstance(record);
        assert(gatewayInstance);
        const retainedBeforeRun = gatewayInstance.retainedWorkCount;
        runLease = await withPluginRuntimeRegistryScope(registryOwner.registry, () =>
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
        );
        const tool = resolveTools().find(({ name }) => name === toolName);
        assert(tool, "enabled tool must resolve for the owner agent");
        const result = await tool.execute("visitor-revoke-call", { email: "absent@example.test" });
        expect(result).toMatchObject({
          content: [
            {
              type: "text",
              text: "No visitor grant found for absent@example.test; nothing to revoke.",
            },
          ],
          details: {},
        });
        expect(gatewayInstance.retainedWorkCount).toBeGreaterThan(retainedBeforeRun);
        await runLease[Symbol.asyncDispose]();
        runLease = undefined;
        expect(gatewayInstance.retainedWorkCount).toBe(retainedBeforeRun);
      } finally {
        await runLease?.[Symbol.asyncDispose]();
        await closePreparedModelRuntimeSnapshots();
        await services?.stop({ strict: true });
        await lifetime.stop();
        loaded.forEach((entry) => entry.retireGatewayRuntimeBindings());
        await registryOwner.close();
        await metadata.close();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      }
    });
  },
);
