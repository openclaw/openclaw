import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as logger from "../logger.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryGatewayOwner } from "../plugins/registry-lifecycle.js";
import { clearActivePluginRegistry, createPluginRegistryOwner } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  acquireEffectiveToolInventoryRuntimeModelContext,
  resolveEffectiveToolInventory,
} from "./tools-effective-inventory.js";

const providerPluginId = "inventory-provider";
const providerId = "inventory-dynamic";
const toolPluginId = "inventory-workboard";
const toolName = "workboard_list";
const modelId = "chat-dynamic";
const probeKey = "__openclaw_tools_effective_inventory_probe";

type Probe = {
  event: string;
  generation: string[];
  gateway: string[];
  ownerCurrent: string[];
  tools?: string[];
  retainedWork?: number;
};

afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[probeKey];
  await resetPreparedModelRuntimeSnapshotsForTest();
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  cleanupPluginLoaderFixturesForTest();
});

it("assembles full Gateway plugin tools without widening the selected model generation", async () => {
  await withOpenClawTestState(
    {
      prefix: "openclaw-tools-effective-gateway-plugins-",
      layout: "split",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const providerFile = await state.writeText(
        "plugins/provider/index.cjs",
        `globalThis[${JSON.stringify(probeKey)}]("provider-load");
module.exports = {
  id: ${JSON.stringify(providerPluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(providerId)}, label: "Inventory dynamic provider", auth: [],
      async prepareDynamicModel(ctx) {
        if (ctx.modelId !== ${JSON.stringify(modelId)}) return;
        return {
          id: ctx.modelId, name: "Inventory dynamic model", provider: ctx.provider,
          api: "openai-completions", baseUrl: "https://inventory.invalid/v1",
          reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },
      normalizeToolSchemas(ctx) {
        globalThis[${JSON.stringify(probeKey)}]("normalize", ctx.tools.map(tool => tool.name));
        return ctx.tools;
      },
    });
  },
};`,
      );
      await state.writeJson("plugins/provider/openclaw.plugin.json", {
        id: providerPluginId,
        providers: [providerId],
        configSchema: { type: "object", additionalProperties: false },
      });
      const toolFile = await state.writeText(
        "plugins/workboard/index.cjs",
        `globalThis[${JSON.stringify(probeKey)}]("tool-load");
module.exports = {
  id: ${JSON.stringify(toolPluginId)},
  register(api) {
    api.registerTool(() => {
      globalThis[${JSON.stringify(probeKey)}]("tool-factory");
      return {
        name: ${JSON.stringify(toolName)}, label: "Workboard", description: "List workboard items",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { throw new Error("Inventory must not execute tools"); },
      };
    }, { name: ${JSON.stringify(toolName)} });
  },
};`,
      );
      await state.writeJson("plugins/workboard/openclaw.plugin.json", {
        id: toolPluginId,
        contracts: { tools: [toolName] },
        configSchema: { type: "object", additionalProperties: false },
      });

      const probes: Probe[] = [];
      let closeOnToolFactory = false;
      let closing: Promise<unknown> | undefined;
      const lifecycle: { close?: () => Promise<unknown> } = {};
      (globalThis as Record<string, unknown>)[probeKey] = (event: string, tools?: string[]) => {
        const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
        const ownerCurrent =
          requestRegistry && getPluginRegistryGatewayOwner(requestRegistry)?.current();
        const toolRecord = ownerCurrent?.plugins.find((plugin) => plugin.id === toolPluginId);
        probes.push({
          event,
          generation:
            getPluginRuntimeGenerationRegistry()
              ?.plugins.map((plugin) => plugin.id)
              .toSorted() ?? [],
          gateway:
            getPluginRuntimeGatewayRequestScope()
              ?.pluginRegistry?.plugins.map((plugin) => plugin.id)
              .toSorted() ?? [],
          ownerCurrent: ownerCurrent?.plugins.map((plugin) => plugin.id).toSorted() ?? [],
          ...(tools ? { tools } : {}),
          ...(toolRecord ? { retainedWork: getPluginInstance(toolRecord)?.retainedWorkCount } : {}),
        });
        if (event === "tool-factory" && closeOnToolFactory && lifecycle.close) {
          closeOnToolFactory = false;
          closing = lifecycle.close();
        }
      };
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: `${providerId}/${modelId}` },
            workspace: state.workspaceDir,
          },
        },
        tools: { profile: "coding", alsoAllow: [toolName] },
        plugins: {
          allow: [providerPluginId, toolPluginId],
          load: { paths: [providerFile, toolFile] },
          slots: { memory: "none" },
          entries: {
            [providerPluginId]: { enabled: true },
            [toolPluginId]: { enabled: true },
          },
        },
      };
      const metadata = resolvePluginMetadataSnapshot({
        config,
        env: process.env,
        workspaceDir: state.workspaceDir,
      });
      setGatewayPluginMetadataSnapshot(metadata, {
        config,
        env: process.env,
        workspaceDir: state.workspaceDir,
      });
      const root = await loadAndActivateRootPluginRegistry({
        config,
        workspaceDir: state.workspaceDir,
        cache: false,
      });
      expect(root.plugins.map((plugin) => plugin.id).toSorted()).toEqual([
        providerPluginId,
        toolPluginId,
      ]);
      const owner = createPluginRegistryOwner(root, state.workspaceDir);
      lifecycle.close = owner.close;
      const warnings: string[] = [];
      const warn = vi.spyOn(logger, "logWarn").mockImplementation((message) => {
        warnings.push(message);
      });
      const resolveInventory = async (inventoryConfig: OpenClawConfig, normalizeProvider = true) =>
        await withPluginRuntimeRegistryScope(owner.registry, async () => {
          const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
            cfg: inventoryConfig,
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            modelProvider: providerId,
            modelId,
          });
          try {
            return await acquired.run((runtime) => {
              (globalThis as unknown as Record<string, (...args: unknown[]) => void>)[probeKey]?.(
                "before-resolve",
              );
              return resolveEffectiveToolInventory({
                cfg: inventoryConfig,
                agentId: "main",
                agentDir: state.agentDir(),
                workspaceDir: state.workspaceDir,
                modelProvider: normalizeProvider ? providerId : undefined,
                modelId: normalizeProvider ? modelId : undefined,
                modelApi: normalizeProvider ? runtime.modelApi : undefined,
                runtimeModel: normalizeProvider ? runtime.runtimeModel : undefined,
              });
            });
          } finally {
            await acquired[Symbol.asyncDispose]();
          }
        });
      try {
        const inventory = await resolveInventory(config);
        expect(inventory.groups.flatMap((group) => group.tools)).toContainEqual(
          expect.objectContaining({ id: toolName, source: "plugin", pluginId: toolPluginId }),
        );
        expect(warnings.filter((message) => message.includes("unknown entries"))).toEqual([]);

        const disabledConfig: OpenClawConfig = {
          ...config,
          plugins: {
            ...config.plugins,
            entries: {
              ...config.plugins?.entries,
              [toolPluginId]: { enabled: false },
            },
          },
        };
        const factoryCount = probes.filter((probe) => probe.event === "tool-factory").length;
        const disabledInventory = await resolveInventory(disabledConfig);
        expect(disabledInventory.groups.flatMap((group) => group.tools)).not.toContainEqual(
          expect.objectContaining({ id: toolName }),
        );
        expect(probes.filter((probe) => probe.event === "tool-factory")).toHaveLength(factoryCount);

        closeOnToolFactory = true;
        const closingInventory = await resolveInventory(config, false);
        expect(closingInventory.groups.flatMap((group) => group.tools)).toContainEqual(
          expect.objectContaining({ id: toolName, source: "plugin", pluginId: toolPluginId }),
        );
        expect(closing).toBeDefined();
        await closing;
      } finally {
        warn.mockRestore();
        await owner.close();
      }

      expect(probes.filter((probe) => probe.event === "tool-load")).toHaveLength(1);
      expect(probes.find((probe) => probe.event === "tool-factory")).toMatchObject({
        generation: [providerPluginId],
        gateway: [providerPluginId, toolPluginId],
        ownerCurrent: [providerPluginId, toolPluginId],
        retainedWork: 1,
      });
      expect(probes.find((probe) => probe.event === "normalize")).toMatchObject({
        generation: [providerPluginId],
        gateway: [providerPluginId],
        ownerCurrent: [providerPluginId, toolPluginId],
        tools: expect.arrayContaining([toolName]),
      });
    },
  );
});
