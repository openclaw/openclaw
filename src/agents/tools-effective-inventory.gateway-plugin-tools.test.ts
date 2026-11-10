import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as logger from "../logger.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import * as pluginLoader from "../plugins/loader.js";
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  hasAnyAuthProfileStoreSourceAsync,
  hasLocalAuthProfileStoreSourceAsync,
} from "./auth-profiles/source-check.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
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
  workspace?: string;
};

afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[probeKey];
  await resetPreparedModelRuntimeSnapshotsForTest();
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  cleanupPluginLoaderFixturesForTest();
});

async function writeProviderFixture(state: OpenClawTestState, normalize = false) {
  const model = makeProviderModelFixture({
    id: modelId,
    provider: providerId,
    api: "openai-completions",
    baseUrl: "https://inventory.invalid/v1",
  });
  const file = await state.writeText(
    "plugins/provider/index.cjs",
    `module.exports = {
  id: ${JSON.stringify(providerPluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(providerId)}, label: "Inventory dynamic provider", auth: [],
      async prepareDynamicModel(ctx) {
        if (ctx.modelId === ${JSON.stringify(modelId)}) return ${JSON.stringify(model)};
      },
      ${
        normalize
          ? `normalizeToolSchemas(ctx) {
        globalThis[${JSON.stringify(probeKey)}]("normalize", ctx.tools.map(tool => tool.name));
        return ctx.tools;
      },`
          : ""
      }
    });
  },
};`,
  );
  await state.writeJson("plugins/provider/openclaw.plugin.json", {
    id: providerPluginId,
    providers: [providerId],
    configSchema: { type: "object", additionalProperties: false },
  });
  return file;
}

async function createGatewayInventoryOwner(config: OpenClawConfig, workspaceDir: string) {
  const metadataContext = { config, env: process.env, workspaceDir };
  const metadata = resolvePluginMetadataSnapshot(metadataContext);
  setGatewayPluginMetadataSnapshot(metadata, metadataContext);
  const root = await loadAndActivateRootPluginRegistry({ config, workspaceDir, cache: false });
  return { root, owner: createPluginRegistryOwner(root, workspaceDir), metadata, metadataContext };
}

it.each([
  { context: "an OpenAI Codex preview", mode: "preview" },
  { context: "a selected-model scope with equal Research workspace", mode: "equal" },
  { context: "a selected-model scope with distinct Research workspace", mode: "distinct" },
])("includes X search for $context", async ({ mode }) => {
  await withOpenClawTestState(
    {
      prefix: "openclaw-xai-inventory-",
      layout: "split",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
        XAI_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
    },
    async (state) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider I/O"));
      onTestFinished(() => fetch.mockRestore());
      await state.writeText("research-workspace/.keep", "synthetic Research workspace\n");
      const workspaceDir =
        mode === "distinct" ? state.statePath("research-workspace") : state.workspaceDir;
      const selected = mode !== "preview";
      const providerFile = selected ? await writeProviderFixture(state) : undefined;
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: selected ? `${providerId}/${modelId}` : "openai/inventory-openai",
            workspace: state.workspaceDir,
          },
          entries: { main: {}, research: { workspace: workspaceDir } },
        },
        tools: { profile: "full", allow: ["x_search"] },
        plugins: {
          allow: selected ? [providerPluginId, "xai"] : ["xai"],
          load: providerFile ? { paths: [providerFile] } : undefined,
          slots: { memory: "none" },
          entries: {
            ...(selected ? { [providerPluginId]: { enabled: true } } : {}),
            xai: { enabled: true, config: { xSearch: { enabled: true } } },
          },
        },
      };
      await state.writeConfig(config);
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "xai:synthetic": {
            type: "oauth",
            provider: "xai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 3_600_000,
          },
        },
      });
      const agentDir = state.agentDir("research");
      expect(await hasLocalAuthProfileStoreSourceAsync(agentDir)).toBe(false);
      expect(await hasAnyAuthProfileStoreSourceAsync(agentDir)).toBe(true);
      const { root, owner } = await createGatewayInventoryOwner(config, state.workspaceDir);
      try {
        expect(root.plugins.find((plugin) => plugin.id === "xai")?.status).toBe("loaded");
        const inventory = await withPluginRuntimeRegistryScope(owner.registry, async () => {
          const params = {
            cfg: config,
            agentId: "research",
            agentDir,
            workspaceDir,
            modelProvider: selected ? providerId : "openai",
            modelId: selected ? modelId : "inventory-openai",
          };
          if (selected) {
            await using acquired = await acquireEffectiveToolInventoryRuntimeModelContext(params);
            return await acquired.run((runtime) =>
              resolveEffectiveToolInventory({
                ...params,
                modelApi: runtime.modelApi,
                runtimeModel: runtime.runtimeModel,
              }),
            );
          }
          return await resolveEffectiveToolInventory({
            ...params,
            agentRuntime: "codex",
            modelApi: "openai-responses",
            runtimeModel: makeProviderModelFixture({
              id: "inventory-openai",
              provider: "openai",
              api: "openai-responses",
              baseUrl: "https://inventory.invalid/v1",
            }),
          });
        });
        expect(inventory.groups.flatMap((group) => group.tools)).toEqual([
          expect.objectContaining({ id: "x_search", source: "plugin", pluginId: "xai" }),
        ]);
        expect(inventory.toolAccess?.tools.find((tool) => tool.id === "x_search")).toMatchObject({
          status: "available",
          reasons: [],
        });
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await owner.close();
      }
    },
  );
});

it("assembles full Gateway plugin tools without widening the selected model generation", async () => {
  await withOpenClawTestState(
    {
      prefix: "openclaw-tools-effective-gateway-plugins-",
      layout: "split",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const providerFile = await writeProviderFixture(state, true);
      const toolFile = await state.writeText(
        "plugins/workboard/index.cjs",
        `globalThis[${JSON.stringify(probeKey)}]("tool-load");
module.exports = {
  id: ${JSON.stringify(toolPluginId)},
  register(api) {
    api.registerTool((ctx) => {
      globalThis[${JSON.stringify(probeKey)}]("tool-factory", undefined, ctx.workspaceDir);
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
      const pluginIds = (registry: ReturnType<typeof getPluginRuntimeGenerationRegistry>) =>
        registry?.plugins.map((plugin) => plugin.id).toSorted() ?? [];
      (globalThis as Record<string, unknown>)[probeKey] = (
        event: string,
        tools?: string[],
        workspace?: string,
      ) => {
        const requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
        const ownerCurrent =
          requestRegistry && getPluginRegistryGatewayOwner(requestRegistry)?.current();
        const toolRecord = ownerCurrent?.plugins.find((plugin) => plugin.id === toolPluginId);
        probes.push({
          event,
          generation: pluginIds(getPluginRuntimeGenerationRegistry()),
          gateway: pluginIds(requestRegistry),
          ownerCurrent: pluginIds(ownerCurrent),
          ...(tools ? { tools } : {}),
          ...(workspace ? { workspace } : {}),
          ...(toolRecord ? { retainedWork: getPluginInstance(toolRecord)?.retainedWorkCount } : {}),
        });
        if (event === "tool-factory" && closeOnToolFactory && lifecycle.close) {
          closeOnToolFactory = false;
          closing = lifecycle.close();
        }
      };
      await state.writeText("research-workspace/.keep", "synthetic Research workspace\n");
      const researchWorkspace = state.statePath("research-workspace");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: `${providerId}/${modelId}` },
            workspace: state.workspaceDir,
          },
          entries: { main: {}, research: { workspace: researchWorkspace } },
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
      const { root, owner, metadata, metadataContext } = await createGatewayInventoryOwner(
        config,
        state.workspaceDir,
      );
      expect(pluginIds(root)).toEqual([providerPluginId, toolPluginId]);
      lifecycle.close = owner.close;
      const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
      const loadRegistry = vi.spyOn(pluginLoader, "loadPluginRegistryHandle");
      const loadPlugins = vi.spyOn(pluginLoader, "loadOpenClawPlugins");
      const inventoryParams = {
        agentId: "research",
        agentDir: state.agentDir("research"),
        workspaceDir: researchWorkspace,
        modelProvider: providerId,
        modelId,
      };
      const resolveInventory = async (inventoryConfig: OpenClawConfig, normalizeProvider = true) =>
        await withPluginRuntimeRegistryScope(owner.registry, async () => {
          await using acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
            cfg: inventoryConfig,
            ...inventoryParams,
          });
          return await acquired.run((runtime) =>
            resolveEffectiveToolInventory({
              cfg: inventoryConfig,
              ...inventoryParams,
              modelProvider: normalizeProvider ? providerId : undefined,
              modelId: normalizeProvider ? modelId : undefined,
              modelApi: normalizeProvider ? runtime.modelApi : undefined,
              runtimeModel: normalizeProvider ? runtime.runtimeModel : undefined,
            }).then((inventory) => inventory.groups.flatMap((group) => group.tools)),
          );
        });
      try {
        const inventory = await resolveInventory(config);
        expect(inventory).toContainEqual(
          expect.objectContaining({ id: toolName, source: "plugin", pluginId: toolPluginId }),
        );
        expect(warn.mock.calls.some(([message]) => message.includes("unknown entries"))).toBe(
          false,
        );
        for (let repeat = 0; repeat < 2; repeat++) {
          expect(await resolveInventory(config)).toContainEqual(
            expect.objectContaining({ id: toolName, source: "plugin", pluginId: toolPluginId }),
          );
        }
        expect(loadRegistry).not.toHaveBeenCalled();
        expect(loadPlugins).not.toHaveBeenCalled();

        const disabledConfig = {
          ...config,
          plugins: { ...config.plugins, entries: { ...config.plugins?.entries } },
        };
        disabledConfig.plugins.entries[toolPluginId] = { enabled: false };
        const factoryCount = probes.filter((probe) => probe.event === "tool-factory").length;
        const disabledInventory = await resolveInventory(disabledConfig);
        expect(disabledInventory).not.toContainEqual(expect.objectContaining({ id: toolName }));
        expect(probes.filter((probe) => probe.event === "tool-factory")).toHaveLength(factoryCount);

        await withPluginRuntimeRegistryScope(owner.registry, async () => {
          await using acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
            cfg: config,
            ...inventoryParams,
          });
          await acquired.run(async (runtime) => {
            const expectNoRecovery = async (inventoryConfig = config) => {
              const before = probes.filter((probe) => probe.event === "tool-factory").length;
              const result = await resolveEffectiveToolInventory({
                cfg: inventoryConfig,
                ...inventoryParams,
                modelApi: runtime.modelApi,
                runtimeModel: runtime.runtimeModel,
              });
              expect(result.groups.flatMap((group) => group.tools)).not.toContainEqual(
                expect.objectContaining({ id: toolName }),
              );
              expect(probes.filter((probe) => probe.event === "tool-factory")).toHaveLength(before);
            };
            // Same plugins, different discovery precedence: the fingerprint must still reject it.
            await expectNoRecovery({
              ...config,
              plugins: { ...config.plugins, load: { paths: [toolFile, providerFile] } },
            });
            // A new metadata generation must not borrow this owner's older registry.
            setGatewayPluginMetadataSnapshot(
              { ...metadata, manifestRegistry: { ...metadata.manifestRegistry } },
              metadataContext,
            );
            try {
              await expectNoRecovery();
            } finally {
              setGatewayPluginMetadataSnapshot(metadata, metadataContext);
            }
            const gatewayOwner = getPluginRegistryGatewayOwner(root);
            expect(gatewayOwner).toBeDefined();
            const unavailableOwner = vi.spyOn(gatewayOwner!, "current").mockReturnValue(undefined);
            try {
              await expectNoRecovery();
            } finally {
              unavailableOwner.mockRestore();
            }
          });
        });

        closeOnToolFactory = true;
        const closingInventory = await resolveInventory(config, false);
        expect(closingInventory).toContainEqual(
          expect.objectContaining({ id: toolName, source: "plugin", pluginId: toolPluginId }),
        );
        expect(closing).toBeDefined();
        await closing;
      } finally {
        loadRegistry.mockRestore();
        loadPlugins.mockRestore();
        warn.mockRestore();
        await owner.close();
      }

      expect(probes.filter((probe) => probe.event === "tool-load")).toHaveLength(1);
      expect(probes.find((probe) => probe.event === "tool-factory")).toMatchObject({
        generation: [providerPluginId],
        gateway: [providerPluginId, toolPluginId],
        ownerCurrent: [providerPluginId, toolPluginId],
        retainedWork: 1,
        workspace: researchWorkspace,
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
