import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import {
  createPreparedInboundRegistryLoader,
  loadPreparedInboundPluginRegistry,
} from "../agents/prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "../agents/prepared-model-runtime.plugin-context.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import { resolveToolSearchConfig } from "../agents/tool-search.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginRegistryOwner, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

type HeadlessParams = Parameters<
  NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
>[0];

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let config: OpenClawConfig;
let registrations: string;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-cron-preparation-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  registrations = state.path("registrations.jsonl");
  const dir = state.path("plugin");
  for (const artifact of ["source", "built"]) {
    const body = `module.exports = {
      id: "cold-probe",
      register(api) {
        require("node:fs").appendFileSync(${JSON.stringify(registrations)}, JSON.stringify({ artifact: ${JSON.stringify(artifact)}, mode: api.registrationMode }) + "\\n");
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

function readRegistrations() {
  return fs
    .readFileSync(registrations, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { artifact: string; mode: string });
}

async function executeProbe({ ctx }: HeadlessParams): Promise<CodeModeHeadlessResult> {
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
    value: { state: result },
    output: [],
    toolCallCount: tool ? 1 : 0,
  };
}

describe("cron preparation plugin ownership", () => {
  it("borrows the current Gateway plugins for detached conditions before and after reload", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
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
        runHeadless: async (params) => {
          const result = await executeProbe(params);
          return result.status === "completed"
            ? { ...result, value: { fire: true, state: result.value } }
            : result;
        },
      });
    const evaluate = (runtime: ReturnType<typeof createRuntime>) =>
      runInDetachedAsyncContext(() =>
        runScheduled(() =>
          runtime.evaluateTrigger({
            jobId: "detached-condition",
            agentId: "main",
            toolsAllow: ["cold_probe"],
            script: "return { fire: true }",
            state: null,
          }),
        ),
      );
    try {
      const runtime = createRuntime(config);
      await expect(evaluate(runtime)).resolves.toMatchObject({
        kind: "evaluated",
        fire: true,
        state: { state: { artifact: "built", generation: 1, calls: 1 } },
      });
      expect(readRegistrations()).toEqual([{ artifact: "built", mode: "full" }]);

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
        await expect(evaluate(nextRuntime)).resolves.toMatchObject({
          kind: "evaluated",
          fire: true,
          state: { state: { artifact: "built", generation: 2, calls: 1 } },
        });
      }
      expect(readRegistrations()).toEqual([
        { artifact: "built", mode: "full" },
        { artifact: "built", mode: "full" },
      ]);
    } finally {
      await owner.close();
    }
  });

  it.each(["gateway", "standalone"] as const)(
    "preserves %s artifact selection through both real preparation loads",
    async (owner) => {
      // Artifact selection must not depend on how long cold module loading takes.
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const metadataSnapshot = loadPluginMetadataSnapshot({
        config,
        workspaceDir: state.workspaceDir,
      });
      setCurrentPluginMetadataSnapshot(metadataSnapshot, { config });
      const contexts: Array<ReturnType<typeof getPluginRuntimeLoadContext>> = [];
      const deps = {
        config,
        ...(owner === "gateway" ? { loadPluginRegistry: loadPreparedInboundPluginRegistry } : {}),
        runHeadless: async (params: HeadlessParams) => {
          contexts.push(
            getPluginRuntimeLoadContext(getPluginRuntimeGatewayRequestScope()?.pluginRegistry),
          );
          return executeProbe(params);
        },
      };
      const runtime = createCronScriptRuntime(deps);
      const artifact = owner === "gateway" ? "built" : "source";
      const run = (jobId: string, agentId = "main", toolsAllow = ["*"]) =>
        runtime.executePayload({
          jobId,
          agentId,
          toolsAllow,
          script: "return {}",
          state: null,
          timeoutSeconds: 5,
        });
      for (const [jobId, agentId, calls] of [
        ["first", "main", 1],
        ["first", "main", 1],
        ["second", "main", 1],
        ["first", "other", 1],
      ] as const) {
        await expect(run(jobId, agentId)).resolves.toMatchObject({
          kind: "completed",
          state: { artifact, calls, agentId, sessionKey: `agent:${agentId}:cron:${jobId}:trigger` },
        });
      }
      expect(readRegistrations()).toEqual(
        expect.arrayContaining([
          { artifact, mode: "discovery" },
          { artifact, mode: "tool-discovery" },
        ]),
      );
      expect(readRegistrations().every((entry) => entry.artifact === artifact)).toBe(true);
      if (owner === "gateway") {
        expect(contexts[0]?.metadataSnapshot).toBe(metadataSnapshot);
        expect(contexts[1]).toBe(contexts[0]);
      }
      await expect(run("first", "other", [])).resolves.toMatchObject({
        kind: "completed",
        state: null,
      });
      await expect(run("first", "other", ["cold_probe"])).resolves.toMatchObject({
        kind: "completed",
        state: { calls: 1 },
      });
      const nextConfig = structuredClone(config);
      nextConfig.tools = { deny: ["cold_probe"] };
      setRuntimeConfigSnapshot(nextConfig, config);
      await expect(run("first", "other", ["cold_probe"])).resolves.toMatchObject({
        kind: "completed",
        state: null,
      });
    },
  );

  it.each(["scoped", "global"] as const)(
    "uses only %s registry ownership during downstream loading without a model runtime",
    async (owner) => {
      const input = { config, workspaceDir: state.workspaceDir, agentDir: state.agentDir() };
      const metadataSnapshot = loadPluginMetadataSnapshot(input);
      const registry = createPreparedInboundRegistryLoader()(input, metadataSnapshot);
      prepareOwnedPluginLoadContext(input, process.env, registry, metadataSnapshot, true);
      if (owner === "global") {
        setActivePluginRegistry(registry);
      }
      const tools = withPluginRuntimeRegistryScope(owner === "scoped" ? registry : undefined, () =>
        resolveOpenClawPluginToolsForOptions({
          options: {
            config,
            workspaceDir: state.workspaceDir,
            agentSessionKey: "agent:main:cron:scoped:trigger",
            pluginToolAllowlist: ["cold_probe"],
          },
          resolvedConfig: config,
        }),
      );
      expect(tools.map((tool) => tool.name)).toEqual(["cold_probe"]);
      await expect(tools[0]!.execute("scoped-call", {})).resolves.toMatchObject({
        details: {
          artifact: owner === "scoped" ? "built" : "source",
          agentId: "main",
          sessionKey: "agent:main:cron:scoped:trigger",
        },
      });
      expect(readRegistrations()).toEqual([
        { artifact: "built", mode: "discovery" },
        { artifact: owner === "scoped" ? "built" : "source", mode: "tool-discovery" },
      ]);
    },
  );
});
