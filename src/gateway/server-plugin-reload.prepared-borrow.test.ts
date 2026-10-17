import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import { scopePreparedModelRuntimeLease } from "../agents/prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  markPreparedModelRuntimeSnapshotsStale,
} from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeLease } from "../agents/prepared-model-runtime.types.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createPluginsTool } from "../agents/tools/plugins-tool.js";
import { createTestReplyOperation } from "../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
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
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
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
import type { GatewayRequestHandler } from "./server-methods/types.js";
import * as bootstrap from "./server-plugin-bootstrap.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { refreshModelRuntimeAfterHotReload } from "./server-reload-model-runtime-scope.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";

function modelConfig(workspace: string): Pick<OpenClawConfig, "agents" | "models"> {
  return {
    agents: {
      ownership: "explicit",
      entries: { main: { workspace, model: "fixture/probe" } },
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
  };
}

async function createPublishedPluginFixture(
  config: OpenClawConfig,
  workspaceDir: string,
  logs: Pick<ReturnType<typeof createSubsystemLogger>, "info" | "warn" | "error" | "debug">,
  services: Parameters<typeof createGatewayPluginRuntimeGeneration>[0] = {
    getServices: () => null,
    setServices() {},
  },
) {
  const env = process.env;
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
    pluginWorkspaceDir: workspaceDir,
    kernel: {
      pluginRuntimeGeneration: createGatewayPluginRuntimeGeneration(services),
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
    metadataSnapshot,
    registryOwner,
    scheduler,
    runtime,
    log,
    reloadOptions,
    async acquireTurn(
      snapshot?: Awaited<ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>,
    ): Promise<PreparedModelRuntimeLease> {
      const published =
        snapshot ?? (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" }));
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
    },
    publish: () =>
      withPluginRuntimeRegistryScope(registryOwner.registry, () =>
        publishConfiguredModelRuntimeSnapshots({
          cfg: config,
          pluginMetadataSnapshot: metadataSnapshot,
          workspaceDir,
        }),
      ),
    refresh: (nextConfig: OpenClawConfig) =>
      withPluginRuntimeRegistryScope(registryOwner.registry, () =>
        refreshModelRuntimeAfterHotReload({
          config: nextConfig,
          agentIds: undefined,
          pluginMetadataSnapshot: runtime.pluginMetadataSnapshot,
        }),
      ),
    tools: (toolName: string, lease?: PreparedModelRuntimeLease, currentConfig = config) =>
      withPluginRuntimeRegistryScope(registryOwner.registry, () =>
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
    async close() {
      await lifetime.stop();
      loaded.forEach((entry) => entry.retireGatewayRuntimeBindings());
      await registryOwner.close();
      await metadata.close();
      await scheduler.stop();
    },
  };
}

const evaluations = Symbol.for("openclaw.test.preparedBorrowEvaluations");
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("prepared Gateway plugin borrowing", () => {
  const toolPluginId = "borrow-tool";
  const providerPluginId = "borrow-provider";
  const toolName = "borrow_probe";

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
  it.each(["plugins.reload", "auth refresh", "tool handoff"] as const)(
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
          ...modelConfig(state.workspaceDir),
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
        const fixture = await createPublishedPluginFixture(config, state.workspaceDir, logs);
        const { initial, registryOwner, reloadOptions } = fixture;
        const gatewayRecord = (registry: PluginRegistry) => {
          const record = registry.plugins.find((entry) => entry.id === toolPluginId);
          assert(record);
          return record;
        };
        const executeProbe = async (lease: PreparedModelRuntimeLease) => {
          const tool = fixture.tools(toolName, lease).find(({ name }) => name === toolName);
          assert(tool, "the Gateway plugin tool must resolve for the prepared turn");
          return await tool.execute("borrow-probe", {});
        };
        let lease: PreparedModelRuntimeLease | undefined;
        try {
          await fixture.publish();
          lease = await fixture.acquireTurn();
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
            const next = await fixture.acquireTurn();
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
          const startReload = () =>
            reloadGatewayPlugins(reloadOptions, {
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
            });
          if (change === "tool handoff") {
            const sessionKey = "agent:main:reload-handoff";
            const sessionId = "reload-handoff-session";
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey },
              { sessionId, updatedAt: 1 },
            );
            const scopedLease = scopePreparedModelRuntimeLease(lease);
            const operation = createTestReplyOperation({ sessionKey, sessionId });
            operation.setPhase("running");
            const cleanup = createDeferredCore();
            const resumed = createDeferredCore<string>();
            const handler: GatewayRequestHandler = async ({ respond }) => {
              // Provider catalog refresh may still retain the plugin after this turn closes.
              expect(lease).toBeUndefined();
              await startReload();
              respond(true, { ok: true, runtime: { generation: 2, pluginIds: [toolPluginId] } });
            };
            const context = createContext([
              ["plugins.reload", "operator.admin", "plugins", handler],
            ]);
            context.getRuntimeConfig = () => config;
            context.resolveGatewayContext = () => context;
            const enqueue = vi
              .spyOn(sessionEvents, "enqueueSessionEventForHost")
              .mockImplementation((text, options) => {
                expect(options.expectedTarget?.sessionId).toBe(sessionId);
                expect(options.sessionKey).toBe(sessionKey);
                resumed.resolve(text);
                return {
                  id: "resume",
                  cancel: () => false,
                  accepted: Promise.resolve({ ok: true }),
                  settled: Promise.resolve({
                    status: "completed",
                    executionStarted: true,
                    delivered: false,
                  }),
                };
              });
            try {
              await withPluginRuntimeGatewayRequestScope(
                { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
                () =>
                  withOperatorToolGatewayAuthority(
                    { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
                    () =>
                      withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, () =>
                        scopedLease.run(async () => {
                          const result = await createPluginsTool({
                            sessionId,
                            onYield: () => {
                              operation.completeWithAfterClearBarrier(
                                (async () => {
                                  await cleanup.promise;
                                  await scopedLease[Symbol.asyncDispose]();
                                  lease = undefined;
                                })(),
                              );
                            },
                          }).execute("reload-handoff", {
                            action: "reloadAndResume",
                            pluginId: toolPluginId,
                          });
                          expect(result.details).toMatchObject({
                            status: "started",
                            async: true,
                            yielded: true,
                          });
                          expect(oldInstance.retainedWorkCount).toBeGreaterThan(0);
                          expect(enqueue).not.toHaveBeenCalled();
                          cleanup.resolve();
                          expect(await resumed.promise).toContain('"ok":true');
                          expect(enqueue).toHaveBeenCalledOnce();
                        }),
                      ),
                  ),
              );
            } finally {
              cleanup.resolve();
              operation.complete();
              enqueue.mockRestore();
            }
          } else {
            const reload = startReload();
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
          }
          expect(logs.info).toHaveBeenCalledWith(`Plugin replacement applied: ${toolPluginId}`);
          await disposed.promise;
          expect(oldInstance.disposing).toBe(true);
          expect(oldInstance.acceptingCalls).toBe(false);

          // The refreshed prepared runtime borrows the reloaded Gateway instance.
          const nextRecord = gatewayRecord(registryOwner.registry);
          expect(nextRecord).not.toBe(oldRecord);
          await fixture.refresh(config);
          lease = await fixture.acquireTurn();
          const refreshed = lease.snapshot.pluginRegistry;
          assert(refreshed);
          expect(gatewayRecord(refreshed)).toBe(nextRecord);
          await expect(executeProbe(lease)).resolves.toMatchObject({
            content: [{ type: "text", text: "generation 2" }],
          });
        } finally {
          await lease?.[Symbol.asyncDispose]();
          await closePreparedModelRuntimeSnapshots();
          await fixture.close();
          vi.unstubAllEnvs();
        }
      });
    },
  );
});

describe("published Gateway plugin services", () => {
  // Protect the service-to-agent-tool contract through the actual replacement loader.
  // Existing visitor tests only start an already-enabled plugin; registry recovery
  // fixtures substitute their own candidate loader and do not resolve agent tools.
  it.for(["cold start", "hot enable"] as const)(
    "%s lets a published agent runtime use the visitor service",
    async (mode, { signal }) => {
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
          ...modelConfig(state.workspaceDir),
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
        let services: PluginServicesHandle | null = null;
        const fixture = await createPublishedPluginFixture(config, state.workspaceDir, logs, {
          getServices: () => services,
          setServices: (handle) => {
            services = handle;
          },
        });
        const { initial, registryOwner, scheduler, runtime, log, reloadOptions } = fixture;
        let runLease: Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>> | undefined;
        try {
          // Match post-attach startup: publish configured model owners, start services,
          // then deliver gateway_start before admitting the first owner turn.
          await fixture.publish();
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
            expect(fixture.tools(toolName, runLease, config)).toEqual([]);
            const nextConfig = configFor(true);
            const changedPaths = [`plugins.entries.${pluginId}.enabled`];
            const plan = buildGatewayReloadPlan(changedPaths, {
              previousConfig: config,
              candidateConfig: nextConfig,
            });
            expect(plan.reloadPlugins).toBe(true);
            expect(plan.restartGateway).toBe(false);
            await state.writeConfig(nextConfig);
            await reloadGatewayPlugins(reloadOptions, {
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
            });
            expect(logs.info).toHaveBeenCalledWith(`Plugin replacement applied: ${pluginId}`);
            await fixture.refresh(config);
          }
          // Use the published owner and the same acquisition as Gateway agent admission.
          const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
          assert(published);
          const record = registryOwner.registry.plugins.find((entry) => entry.id === pluginId);
          assert(record);
          const gatewayInstance = getPluginInstance(record);
          assert(gatewayInstance);
          // Settle startup/catalog work before measuring the independent agent-run lease.
          await gatewayInstance.waitForRetainedWork(signal);
          const retainedBeforeRun = gatewayInstance.retainedWorkCount;
          runLease = await fixture.acquireTurn(published);
          const tool = fixture
            .tools(toolName, runLease, config)
            .find(({ name }) => name === toolName);
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
          await gatewayInstance.waitForRetainedWork(runtime.requestEntryLifetime.signal);
          expect(gatewayInstance.retainedWorkCount).toBe(retainedBeforeRun);
        } finally {
          await runLease?.[Symbol.asyncDispose]();
          await closePreparedModelRuntimeSnapshots();
          await services?.stop({ strict: true });
          await fixture.close();
          vi.unstubAllEnvs();
          vi.unstubAllGlobals();
        }
      });
    },
  );
});
