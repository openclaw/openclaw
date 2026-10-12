import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
} from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeLease } from "../agents/prepared-model-runtime.types.js";
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
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  startPluginServices,
  type PluginServicesHandle,
} from "../plugins/services.test-support.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
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

describe("prepared Gateway plugin borrowing", () => {
  beforeEach(async () => {
    await resetPreparedModelRuntimeSnapshotsForTest();
    resetPluginRuntimeStateForTest();
    resetGatewayWorkAdmission();
  });

  afterEach(async () => {
    await clearActivePluginRegistry();
    clearPluginMetadataLifecycleCaches();
    resetGatewayWorkAdmission();
    Reflect.deleteProperty(globalThis, evaluations);
  });

  const toolPluginId = "borrow-tool";
  const providerPluginId = "borrow-provider";
  const toolName = "borrow_probe";
  const evaluations = Symbol.for("openclaw.test.preparedBorrowEvaluations");

  function writeFixturePlugin(
    root: string,
    id: string,
    manifest: object,
    register: string,
  ): string {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({ id, configSchema: { type: "object", properties: {} }, ...manifest }),
    );
    const file = path.join(dir, "index.cjs");
    fs.writeFileSync(
      file,
      `const counts = (globalThis[Symbol.for("openclaw.test.preparedBorrowEvaluations")] ??= {});
      const generation = (counts[${JSON.stringify(id)}] = (counts[${JSON.stringify(id)}] ?? 0) + 1);
      module.exports = { id: ${JSON.stringify(id)}, register(api) { ${register} } };`,
    );
    return file;
  }

  // Protect prepared-turn custody of Gateway-owned instances through the real loader, auth
  // republication, and reload owners. Existing reload fixtures substitute their own loaders.
  it.each(["plugins.reload", "auth refresh"] as const)(
    "borrows unchanged Gateway instances into prepared turns across %s",
    async (change) => {
      await withOpenClawTestState({ label: "prepared-gateway-borrow" }, async (state) => {
        const queued = createDeferredCore();
        const disposed = createDeferredCore();
        const disposalEvent = `prepared-borrow-disposed:${state.workspaceDir}`;
        const onDisposed = (generation: number) => {
          if (generation === 1) {
            disposed.resolve();
          }
        };
        process.on(disposalEvent, onDisposed);
        using _ = { [Symbol.dispose]: () => process.off(disposalEvent, onDisposed) };
        const toolFile = writeFixturePlugin(
          state.path("plugins"),
          toolPluginId,
          { contracts: { tools: [toolName] } },
          `api.lifecycle.onDispose(() => process.emit(${JSON.stringify(disposalEvent)}, generation));
          api.registerTool({ name: ${JSON.stringify(toolName)}, description: "Report the module generation",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "generation " + generation }] }; } });`,
        );
        const providerFile = writeFixturePlugin(
          state.path("plugins"),
          providerPluginId,
          { providers: ["fixture"] },
          "",
        );
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
        const env = process.env;
        const config: OpenClawConfig = {
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
            allow: [toolPluginId, providerPluginId],
            load: { paths: [toolFile, providerFile] },
            slots: { memory: "none" },
            entries: { [toolPluginId]: { enabled: true }, [providerPluginId]: { enabled: true } },
          },
          tools: { allow: [toolName] },
        };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        const logs = {
          info: vi.fn((message: string) => {
            if (message.includes("Plugin replacement queued behind")) {
              queued.resolve();
            }
          }),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        };
        const log = { ...createSubsystemLogger("gateway/plugins"), ...logs };
        const metadataSnapshot = await resolveConfigWidePluginMetadataSnapshotAsync({
          config,
          env,
        });
        const initial = await bootstrap.prepareGatewayPluginLoad({
          pluginMetadataSnapshot: metadataSnapshot,
          pluginLookUpTable: loadPluginLookUpTable({
            config,
            workspaceDir: state.workspaceDir,
            env,
            metadataSnapshot,
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
        activatePluginRegistry(
          initial.pluginRegistry,
          null,
          "gateway-bindable",
          state.workspaceDir,
        );
        const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, state.workspaceDir);
        const scheduler = createTestGatewayScheduler();
        const metadata = retainGatewayPluginMetadata(scheduler);
        metadata.publish(metadataSnapshot);
        const loaded = [initial];
        const lifetime = createGatewaySidecarStopOwner();
        const runtime = {
          scheduler,
          requestEntryLifetime: new GatewayRequestEntryLifetime(),
          pluginMetadataSnapshot: metadataSnapshot,
          pluginRuntime: registryOwner,
          pluginWorkspaceDir: state.workspaceDir,
          kernel: {
            pluginRuntimeGeneration: createGatewayPluginRuntimeGeneration({
              getServices: () => null,
              setServices: () => {},
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
        const gatewayRecord = (registry: PluginRegistry) => {
          const record = registry.plugins.find((entry) => entry.id === toolPluginId);
          assert(record);
          return record;
        };
        const acquireTurn = async (): Promise<PreparedModelRuntimeLease> => {
          const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
          assert(published);
          return await withPluginRuntimeRegistryScope(registryOwner.registry, () =>
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
        };
        const executeProbe = async (lease: PreparedModelRuntimeLease) => {
          const tool = withPluginRuntimeRegistryScope(registryOwner.registry, () =>
            resolveOpenClawPluginToolsForOptions({
              resolvedConfig: config,
              options: {
                config,
                workspaceDir: state.workspaceDir,
                agentSessionKey: "agent:main:main",
                senderIsOwner: true,
                preparedModelRuntime: lease.snapshot,
                pluginToolAllowlist: [toolName],
                assertInvocationCurrent: () => {},
              },
            }),
          ).find(({ name }) => name === toolName);
          assert(tool, "the Gateway plugin tool must resolve for the prepared turn");
          return await tool.execute("borrow-probe", {});
        };
        let lease: PreparedModelRuntimeLease | undefined;
        try {
          await withPluginRuntimeRegistryScope(registryOwner.registry, () =>
            publishConfiguredModelRuntimeSnapshots({
              cfg: config,
              pluginMetadataSnapshot: metadataSnapshot,
              workspaceDir: state.workspaceDir,
            }),
          );
          lease = await acquireTurn();
          const prepared = lease.snapshot.pluginRegistry;
          assert(prepared);
          const oldRecord = gatewayRecord(initial.pluginRegistry);
          const oldInstance = getPluginInstance(oldRecord);
          assert(oldInstance);
          // The prepared turn lists the Gateway instance; only the provider owner the Gateway lacks loads.
          expect(prepared).not.toBe(initial.pluginRegistry);
          expect(gatewayRecord(prepared)).toBe(oldRecord);
          expect(initial.pluginRegistry.plugins.some(({ id }) => id === providerPluginId)).toBe(
            false,
          );
          expect(prepared.plugins.find(({ id }) => id === providerPluginId)?.status).toBe("loaded");
          expect(Reflect.get(globalThis, evaluations)[toolPluginId]).toBe(1);
          await expect(executeProbe(lease)).resolves.toMatchObject({
            content: [{ type: "text", text: "generation 1" }],
          });

          if (change === "auth refresh") {
            // Credential changes republish the owner while reusing its plugin generation.
            const before = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
            assert(before);
            upsertAuthProfile({
              profileId: "fixture:borrow",
              credential: { type: "api_key", provider: "fixture", key: "synthetic-borrow-key" },
              agentDir: before.agentDir,
            });
            const next = await acquireTurn();
            expect(await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" })).not.toBe(
              before,
            );
            const republished = next.snapshot.pluginRegistry;
            assert(republished);
            expect(gatewayRecord(republished)).toBe(oldRecord);
            await expect(executeProbe(next)).resolves.toMatchObject({
              content: [{ type: "text", text: "generation 1" }],
            });
            // Retiring every prepared generation leaves the Gateway-owned instance live.
            await lease[Symbol.asyncDispose]();
            lease = undefined;
            await next[Symbol.asyncDispose]();
            await closePreparedModelRuntimeSnapshots();
            expect(oldInstance.owner?.registry).toBe(initial.pluginRegistry);
            expect(oldInstance.acceptingCalls).toBe(true);
            expect(oldInstance.disposing).toBe(false);
            return;
          }

          // plugins.reload queues behind the admitted turn instead of disposing its instance.
          const reload = reloadGatewayPlugins(
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
              nextConfig: config,
              sourceConfig: config,
              changedPaths: [],
              pluginLifecycle: {
                pluginIds: [toolPluginId],
                reason: "reload",
                operationId: "borrow-reload",
              },
              prepareConfigEffects: () => ({
                retire: () => {
                  markPreparedModelRuntimeSnapshotsStale("plugin reload", {
                    waitForReplacement: true,
                  });
                },
                rollback: async () => {},
              }),
              env,
              commitRuntime: async (publication) => {
                publication?.publish();
                publication?.afterCommit?.();
              },
            },
          );
          await Promise.race([
            queued.promise,
            reload.then(() => {
              throw new Error("Expected plugin replacement to queue behind the admitted turn");
            }),
          ]);
          expect(oldInstance.acceptingCalls).toBe(true);
          await expect(executeProbe(lease)).resolves.toMatchObject({
            content: [{ type: "text", text: "generation 1" }],
          });
          await lease[Symbol.asyncDispose]();
          lease = undefined;
          await reload;
          expect(logs.info).toHaveBeenCalledWith(`Plugin replacement applied: ${toolPluginId}`);
          await disposed.promise;
          expect(oldInstance.disposing).toBe(true);
          expect(oldInstance.acceptingCalls).toBe(false);

          // The refreshed prepared runtime borrows the reloaded Gateway instance.
          const nextRecord = gatewayRecord(registryOwner.registry);
          expect(nextRecord).not.toBe(oldRecord);
          await withPluginRuntimeRegistryScope(registryOwner.registry, () =>
            refreshModelRuntimeAfterHotReload({
              config,
              agentIds: undefined,
              pluginMetadataSnapshot: runtime.pluginMetadataSnapshot,
            }),
          );
          lease = await acquireTurn();
          const refreshed = lease.snapshot.pluginRegistry;
          assert(refreshed);
          expect(gatewayRecord(refreshed)).toBe(nextRecord);
          await expect(executeProbe(lease)).resolves.toMatchObject({
            content: [{ type: "text", text: "generation 2" }],
          });
        } finally {
          await lease?.[Symbol.asyncDispose]();
          await closePreparedModelRuntimeSnapshots();
          await lifetime.stop();
          loaded.forEach((entry) => entry.retireGatewayRuntimeBindings());
          await registryOwner.close();
          await metadata.close();
          await scheduler.stop();
          vi.unstubAllEnvs();
        }
      });
    },
  );
});

describe("published Gateway plugin services", () => {
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
        const initial = await bootstrap.prepareGatewayPluginLoad({
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
        activatePluginRegistry(
          initial.pluginRegistry,
          null,
          "gateway-bindable",
          state.workspaceDir,
        );
        let services: PluginServicesHandle | null = null;
        const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, state.workspaceDir);
        const scheduler = createTestGatewayScheduler();
        const metadata = retainGatewayPluginMetadata(scheduler);
        metadata.publish(initialMetadata);
        const loaded = [initial];
        const lifetime = createGatewaySidecarStopOwner();
        const runtime = {
          scheduler,
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
            scheduler,
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
            resolveGatewayContext: () => undefined,
            loadSubagentRegistryActivation: async () => () => {},
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
          const result = await tool.execute("visitor-revoke-call", {
            email: "absent@example.test",
          });
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
          await scheduler.stop();
          vi.unstubAllEnvs();
          vi.unstubAllGlobals();
        }
      });
    },
  );
});
