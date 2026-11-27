import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import { loadPreparedInboundPluginRegistry } from "../agents/prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "../agents/prepared-model-runtime.plugin-context.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import { resolveToolSearchConfig } from "../agents/tool-search.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { loadAndActivateRootPluginRegistry, loadOpenClawPluginsAsync } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginRegistryOwner, stageActivePluginRegistry } from "../plugins/runtime.js";
import {
  withPluginRuntimeGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

type HeadlessParams = Parameters<
  NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
>[0];
type Runtime = ReturnType<typeof createCronScriptRuntime>;

const invocation = (jobId: string, agentId = "main", toolsAllow = ["*"]) => ({
  jobId,
  agentId,
  toolsAllow,
  script: "return {}",
  state: null,
});
const expectPayload = (result: ReturnType<Runtime["executePayload"]>, state: unknown) =>
  expect(result).resolves.toMatchObject({ kind: "completed", state });

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let config: OpenClawConfig;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-cron-preparation-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const dir = state.path("plugin");
  for (const artifact of ["source", "built"]) {
    const body = `module.exports = {
      id: "cold-probe",
      register(api) {
        if (api.registrationMode !== "full" && api.registrationMode !== "tool-discovery") return;
        const generation = api.pluginConfig?.generation ?? 1;
        api.registerTool((ctx) => {
          let calls = 0;
          return {
            name: "cold_probe", label: "Cold probe", description: "Fixture preparation probe",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [], details: { artifact: ${JSON.stringify(artifact)}, generation, calls: ++calls, agentId: ctx.agentId, sessionKey: ctx.sessionKey } };
            }
          };
        }, { names: ["cold_probe"] });
      }
    };`;
    writePlugin({
      id: "cold-probe",
      dir: artifact === "source" ? dir : path.join(dir, "dist"),
      filename: artifact === "source" ? "index.ts" : "index.js",
      body,
    });
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "cold-probe", openclaw: { extensions: ["./index.ts"] } }),
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "cold-probe",
      configSchema: { type: "object", properties: { generation: { type: "integer" } } },
      contracts: { tools: ["cold_probe"] },
    }),
  );
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: {
        main: { workspace: state.workspaceDir },
        other: { workspace: state.path("other-workspace") },
      },
    },
    plugins: {
      allow: ["cold-probe"],
      // Explicit source entry keeps artifact selection at the runtime owner boundary.
      load: { paths: [path.join(dir, "index.ts")] },
      slots: { memory: "none" },
      entries: { "cold-probe": { enabled: true } },
    },
  };
});

afterEach(async () => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
  clearPluginLoaderCache();
  clearPluginMetadataLifecycleCaches();
  // Capture retirement still owns its SQLite token beneath the fixture root.
  await expect(waitForPluginCacheRetirement()).resolves.toMatchObject({ failures: [] });
  await state?.cleanup();
});

afterAll(cleanupPluginLoaderFixturesForTest);

it("lets an unchanged script job call a newly published plugin without retiring its registry", async () => {
  const pluginsDir = state.path("online-plugins");
  fs.mkdirSync(pluginsDir);
  config.plugins!.load = { paths: [pluginsDir] };
  let publishedConfig = config;
  const publish = async (published: OpenClawConfig = publishedConfig) => {
    clearPluginMetadataLifecycleCaches();
    const input = { config: published, workspaceDir: state.workspaceDir };
    const metadata = loadPluginMetadataSnapshot(input);
    setCurrentPluginMetadataSnapshot(metadata, { config: published });
    const registry = await loadOpenClawPluginsAsync({
      ...input,
      metadataSnapshot: metadata,
      activate: false,
      cache: false,
      throwOnLoadError: true,
    });
    prepareOwnedPluginLoadContext(input, process.env, registry, metadata, true);
    // Online publication preserves retained preparations; retirement must not
    // accidentally make this addition-only regression pass.
    stageActivePluginRegistry(registry, null, "gateway-bindable", state.workspaceDir);
    return registry;
  };
  let registry = await publish();
  // The Gateway resolves its live config on every invocation; publications
  // between runs must be visible without rebuilding the cron service.
  const gatewayContext = {
    getRuntimeConfig: () => publishedConfig,
    isConfigReloadSettled: () => true,
  } as never;
  const resolveGatewayContext = () => gatewayContext;
  const resourceHost = new LegacyPluginSdkResourceHost();
  const scheduler = createTestGatewayScheduler();
  resourceHost.bindScheduler(scheduler);
  bindLegacyPluginSdkResourceHost(resolveGatewayContext, resourceHost);
  onTestFinished(async () => {
    await resourceHost.close();
    await scheduler.stop();
  });
  const runtime = createCronScriptRuntime({
    config,
    resolveGatewayContext,
    loadPluginRegistry: loadPreparedInboundPluginRegistry,
  });
  const job = {
    ...invocation("existing-job", "main", ["cold_probe"]),
    script: "return { state: await cold_probe({}) };",
  };
  // The service admits each run through the standing active-job marker; mirror
  // that binding so the script's admitted-run assertion sees the occurrence.
  const abort = new AbortController();
  const run = () => {
    const marker = markCronJobActive("existing-job");
    return withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      withPluginRuntimeRegistryScope(registry, () =>
        runtime
          .executePayload({
            ...job,
            deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
            executionIdentity: {
              ingress: { kind: "schedule", boundary: "cron.script", state: "present" },
              onPostAdmission: (admitted) => bindCronJobAdmittedRun(marker, admitted, abort.signal),
            },
          })
          .finally(() => clearCronJobActive("existing-job", marker)),
      ),
    );
  };
  await expect(run()).resolves.toMatchObject({
    kind: "error",
    error: expect.stringContaining("cold_probe is not defined"),
  });
  fs.cpSync(state.path("plugin"), path.join(pluginsDir, "cold-probe"), { recursive: true });
  registry = await publish();
  await expect(run()).resolves.toMatchObject({
    kind: "completed",
    state: { generation: 1, calls: 1, agentId: "main" },
  });
  publishedConfig = {
    ...config,
    plugins: {
      ...config.plugins,
      entries: { "cold-probe": { enabled: true, config: { generation: 2 } } },
    },
  };
  registry = await publish(publishedConfig);
  for (let runIndex = 0; runIndex < 2; runIndex += 1) {
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({
      kind: "completed",
      state: { generation: 2, calls: 1, agentId: "main" },
    });
  }
  abort.abort();
});

async function executeProbe({ ctx }: HeadlessParams, condition = false) {
  const tool = ctx.catalogRef?.current?.entries.find(
    (entry) => entry.tool.name === "cold_probe",
  )?.tool;
  const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.runtimeConfig), {
    prepareInput: true,
    validateInput: true,
  });
  const result = tool ? await runtime.callValue("cold_probe", {}) : null;
  return {
    status: "completed",
    value: condition ? { fire: true, state: { state: result } } : { state: result },
    output: [],
    toolCallCount: tool ? 1 : 0,
  } satisfies CodeModeHeadlessResult;
}

it("borrows the current Gateway plugins for detached conditions before and after reload", async () => {
  // Freeze elapsed-time inputs while allowing native broker startup timers.
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  const loadGateway = async (cfg: OpenClawConfig) => {
    const input = { config: cfg, workspaceDir: state.workspaceDir };
    const metadata = loadPluginMetadataSnapshot(input);
    setCurrentPluginMetadataSnapshot(metadata, { config: cfg });
    const registry = await loadAndActivateRootPluginRegistry({
      ...input,
      manifestRegistry: metadata.manifestRegistry,
      discovery: metadata.discovery,
      runtimeOptions: { allowGatewaySubagentBinding: true },
      preferBuiltPluginArtifacts: true,
      cache: false,
      throwOnLoadError: true,
    });
    prepareOwnedPluginLoadContext(input, process.env, registry, metadata, true);
    return registry;
  };
  const owner = createPluginRegistryOwner(await loadGateway(config), state.workspaceDir);
  const runScheduled = createScheduledGatewayRunner(undefined, () => owner.registry);
  const createRuntime = (cfg: OpenClawConfig) =>
    createCronScriptRuntime({
      config: cfg,
      loadPluginRegistry: loadPreparedInboundPluginRegistry,
      runHeadless: (params) => executeProbe(params, true),
    });
  const expectGeneration = (runtime: Runtime, generation: number) =>
    expect(
      runInDetachedAsyncContext(() =>
        runScheduled(() =>
          runtime.evaluateTrigger({
            ...invocation("detached-condition", "main", ["cold_probe"]),
            script: "return { fire: true }",
          }),
        ),
      ),
    ).resolves.toMatchObject({
      kind: "evaluated",
      fire: true,
      state: { state: { artifact: "built", generation, calls: 1 } },
    });
  try {
    // A Gateway-owned cron service binds its startup config to the active runtime
    // source so later online config publications are visible to each invocation.
    setRuntimeConfigSnapshot(config, config);
    const runtime = createRuntime(config);
    await expectGeneration(runtime, 1);

    const nextConfig: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: { "cold-probe": { enabled: true, config: { generation: 2 } } },
      },
    };
    owner.publish(await loadGateway(nextConfig));
    setRuntimeConfigSnapshot(nextConfig, config);
    // Both an existing watcher and a rebuilt cron service must use the new generation.
    for (const nextRuntime of [runtime, createRuntime(nextConfig)]) {
      await expectGeneration(nextRuntime, 2);
    }
  } finally {
    await owner.close();
  }
});

it.each(["gateway", "standalone"] as const)(
  "preserves %s artifact selection through both real preparation loads",
  async (owner) => {
    // Artifact selection must not depend on how long cold module loading takes.
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      workspaceDir: state.workspaceDir,
    });
    setCurrentPluginMetadataSnapshot(metadataSnapshot, { config });
    const runtime = createCronScriptRuntime({
      config,
      ...(owner === "gateway" ? { loadPluginRegistry: loadPreparedInboundPluginRegistry } : {}),
      runHeadless: executeProbe,
    });
    const artifact = owner === "gateway" ? "built" : "source";
    const run = (jobId: string, agentId = "main", toolsAllow = ["*"]) =>
      runtime.executePayload(invocation(jobId, agentId, toolsAllow));
    for (const [jobId, agentId] of [
      ["first", "main"],
      ["first", "main"],
      ["second", "main"],
      ["first", "other"],
    ] as const) {
      await expectPayload(run(jobId, agentId), {
        artifact,
        calls: 1,
        agentId,
        sessionKey: `agent:${agentId}:cron:${jobId}:trigger`,
      });
    }
    await expectPayload(run("first", "other", []), null);
    await expectPayload(run("first", "other", ["cold_probe"]), { calls: 1 });
    const nextConfig = structuredClone(config);
    nextConfig.tools = { deny: ["cold_probe"] };
    setRuntimeConfigSnapshot(nextConfig, config);
    await expectPayload(run("first", "other", ["cold_probe"]), null);
  },
);
