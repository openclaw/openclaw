import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createToolsEffectiveHandlers,
  testing,
} from "../gateway/server-methods/tools-effective.js";
import { toolsEffectiveTestDependencies } from "../gateway/server-methods/tools-effective.test-support.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { buildBundleMcpToolsFromCatalog } from "./agent-bundle-mcp-tools.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-types.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { acquireReadOnlyPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  acquireEffectiveToolInventoryRuntimeModelContext,
  resolveEffectiveToolInventory,
} from "./tools-effective-inventory.js";
import type { EffectiveToolInventoryResult } from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

// Shell, channel, media, and MCP factories are unrelated to model metadata. Keep
// the real provider normalizer, schema quarantine, notices, and grouping below.
vi.mock("./agent-tools.js", () => {
  const execute = async () => {
    throw new Error("Inventory must not execute tools");
  };
  return {
    createOpenClawCodingTools: () =>
      [
        {
          name: "healthy_tool",
          label: "Healthy tool",
          description: "A tool with a complete input schema.",
          parameters: { type: "object", properties: {} },
          execute,
        },
        {
          name: "parameterless_tool",
          label: "Parameterless tool",
          description: "A parameterless tool normalized by the selected provider.",
          parameters: undefined,
          execute,
        },
      ] as unknown as AnyAgentTool[],
  };
});

const provider = "cold-inventory-provider";
const pluginId = "cold-inventory-plugin";
const pinnedId = "chat-2026-08-17-pinned";
const curatedId = "chat-latest";
const throwingId = "chat-throws";

function ownerCount() {
  // Reuse the existing owner API without importing the harness that mocks preparation.
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.preparedModelRuntimeTestApi")
  ] as { getPreparedModelRuntimeOwnerCountForTest(): number };
  return api.getPreparedModelRuntimeOwnerCountForTest();
}

async function withColdFixture(run: (fixture: ReturnType<typeof createFixture>) => Promise<void>) {
  await withOpenClawTestState(
    { prefix: "openclaw-cold-inventory-", layout: "split" },
    async (state) => {
      const fixture = createFixture(state);
      await withEnvAsync(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: fixture.emptyBundledRoot,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          testing.resetToolsEffectiveCacheForTest();
          try {
            expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
            expect(ownerCount()).toBe(0);
            expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(false);
            await run(fixture);
            expect(isColdPluginRuntimeLoaded(fixture.unrelated)).toBe(false);
            expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
            expect(ownerCount()).toBe(0);
          } finally {
            testing.resetToolsEffectiveCacheForTest();
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
            cleanupPluginLoaderFixturesForTest();
          }
        },
      );
    },
  );
}

function createFixture(state: OpenClawTestState) {
  const root = state.root;
  const selectedRoot = path.join(root, "selected");
  const unrelatedRoot = path.join(root, "unrelated");
  const emptyBundledRoot = path.join(root, "empty-bundled");
  const normalizationTrace = path.join(root, "normalization-trace.jsonl");
  const normalizationFailure = path.join(root, "fail-normalization");
  const agentDir = state.agentDir();
  const workspaceDir = state.workspaceDir;
  for (const dir of [selectedRoot, unrelatedRoot, emptyBundledRoot, agentDir, workspaceDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const selected = createColdPluginFixture({
    rootDir: selectedRoot,
    pluginId,
    providerId: provider,
    manifest: {
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      modelCatalog: {
        providers: {
          [provider]: {
            discovery: "static",
            api: "openai-completions",
            baseUrl: "https://inventory.invalid/v1",
            models: [{ id: curatedId, name: "Curated chat", input: ["text"] }],
          },
        },
      },
    },
  });
  const unrelated = createColdPluginFixture({
    rootDir: unrelatedRoot,
    pluginId: "unrelated-inventory-plugin",
    providerId: "unrelated-inventory-provider",
    runtimeMessage: "Unrelated provider must stay cold",
  });
  fs.writeFileSync(
    selected.runtimeSource,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(selected.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Cold inventory provider", auth: [],
      async prepareDynamicModel(ctx) {
        if (ctx.modelId === ${JSON.stringify(throwingId)}) throw new Error("Provider preparation failed");
        if (ctx.modelId !== ${JSON.stringify(pinnedId)}) return;
        return {
          id: ctx.modelId, name: "Pinned chat", provider: ctx.provider,
          api: "openai-completions", baseUrl: "https://inventory.invalid/v1",
          reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },
      normalizeToolSchemas(ctx) {
        if (ctx.model?.api !== "openai-completions") return ctx.tools;
        const owners = globalThis[Symbol.for("openclaw.preparedModelRuntimeTestApi")]
          .getPreparedModelRuntimeOwnerCountForTest();
        fs.appendFileSync(${JSON.stringify(normalizationTrace)}, JSON.stringify({
          owners, workspaceDir: ctx.workspaceDir, tools: ctx.tools.map(tool => tool.name),
        }) + "\\n");
        if (fs.existsSync(${JSON.stringify(normalizationFailure)})) {
          throw new Error("Synthetic inventory normalization failed");
        }
        return ctx.tools.map(tool => tool.parameters === undefined
          ? { ...tool, parameters: { type: "object", properties: {}, additionalProperties: false } }
          : tool);
      },
    });
  },
};
`,
    "utf8",
  );
  const config: OpenClawConfig = {
    agents: {
      defaults: { model: { primary: `${provider}/${pinnedId}` }, workspace: workspaceDir },
    },
    plugins: {
      load: { paths: [selectedRoot, unrelatedRoot] },
      slots: { memory: "none" },
      entries: { [pluginId]: { enabled: true }, "unrelated-inventory-plugin": { enabled: true } },
    },
  };
  const input = { agentId: "main", agentDir, workspaceDir, config, readOnly: true };
  const inventoryParams = {
    cfg: config,
    agentId: "main",
    agentDir,
    workspaceDir,
    modelProvider: provider,
    modelId: pinnedId,
  };
  return {
    state,
    selected,
    unrelated,
    emptyBundledRoot,
    config,
    input,
    inventoryParams,
    failNormalization: () => fs.writeFileSync(normalizationFailure, "fail", "utf8"),
    readNormalizations: () =>
      fs
        .readFileSync(normalizationTrace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

function pickerIds(fixture: ReturnType<typeof createFixture>) {
  const snapshot = resolvePluginMetadataSnapshot({
    config: fixture.config,
    workspaceDir: fixture.input.workspaceDir,
  });
  return planEffectiveModelCatalogRows({
    registry: snapshot.manifestRegistry,
    config: fixture.config,
    providerFilter: provider,
  }).entries.flatMap((entry) => entry.rows.map((row) => row.id));
}

async function createInventoryInvocation(
  fixture: ReturnType<typeof createFixture>,
  dependencies?: Parameters<typeof createToolsEffectiveHandlers>[0],
) {
  setRuntimeConfigSnapshot(fixture.config);
  const sessionKey = "agent:main:cold-inventory";
  await applySessionEntryLifecycleMutation({
    agentId: "main",
    storePath: path.join(fixture.state.sessionsDir(), "sessions.json"),
    upserts: [
      {
        sessionKey,
        entry: {
          sessionId: "cold-inventory-session",
          updatedAt: 1,
          providerOverride: provider,
          modelOverride: pinnedId,
          modelOverrideSource: "user",
        },
      },
    ],
    skipMaintenance: true,
  });
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(
    createToolsEffectiveHandlers(dependencies)["tools.effective"],
    "default tools.effective handler",
  );
  const invoke = () =>
    handler({
      params: { sessionKey },
      respond,
      context: { getRuntimeConfig: () => fixture.config } as GatewayRequestContext,
      client: null,
      req: { type: "req", id: "cold-inventory", method: "tools.effective" },
      isWebchatConnect: () => false,
    });
  return { respond, invoke };
}

describe("cold dynamic-model effective inventory", () => {
  it("includes provider-supported tools through the default Gateway inventory path", async () => {
    await withColdFixture(async (fixture) => {
      expect(pickerIds(fixture)).toEqual([curatedId]);
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(false);
      const { respond, invoke } = await createInventoryInvocation(fixture);
      await invoke();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.any(Object), undefined);
      const inventory = respond.mock.calls[0]?.[1] as EffectiveToolInventoryResult;
      expect({
        tools: inventory.groups.flatMap((group) => group.tools.map((tool) => tool.id)),
        notices: inventory.notices,
      }).toEqual({
        tools: ["healthy_tool", "parameterless_tool"],
        notices: undefined,
      });
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(true);
      expect(fixture.config.agents?.defaults?.model).toEqual({
        primary: `${provider}/${pinnedId}`,
      });
      expect(pickerIds(fixture)).toEqual([curatedId]);
      expect(fixture.readNormalizations()).toEqual([
        {
          owners: 1,
          workspaceDir: fixture.input.workspaceDir,
          tools: ["healthy_tool", "parameterless_tool"],
        },
      ]);
    });
  });

  it.each([false, true])(
    "owns base and warm MCP normalization without retaining cached models (sandbox: %s)",
    async (sandbox) => {
      await withColdFixture(async (fixture) => {
        const workspaceDir = sandbox
          ? path.join(fixture.state.root, "sandbox")
          : fixture.input.workspaceDir;
        fs.mkdirSync(workspaceDir, { recursive: true });
        const catalog: McpToolCatalog = {
          version: 1,
          generatedAt: 1,
          servers: {},
          tools: [
            {
              serverName: "inventory",
              safeServerName: "inventory",
              toolName: "probe",
              inputSchema: Type.Object({}),
              fallbackDescription: "Synthetic inventory probe",
            },
          ],
        };
        const { invoke, respond } = await createInventoryInvocation(fixture, {
          ...toolsEffectiveTestDependencies,
          acquireEffectiveToolInventoryRuntimeModelContext,
          resolveEffectiveToolInventory,
          buildBundleMcpToolsFromCatalog,
          resolveSessionMcpConfigSummary: () => ({
            fingerprint: "inventory",
            serverNames: ["inventory"],
          }),
          peekSessionMcpRuntime: () => ({
            configFingerprint: "inventory",
            workspaceDir,
            peekCatalog: () => catalog,
          }),
        });
        const ambient = createEmptyPluginRegistry();
        const normalizeAmbient = vi.fn(() => {
          throw new Error("Ambient generation must not normalize prepared inventory");
        });
        ambient.providers.push({
          pluginId: "ambient-provider",
          source: "test",
          provider: {
            id: provider,
            label: "Ambient provider",
            auth: [],
            normalizeToolSchemas: normalizeAmbient,
          },
        });
        for (let request = 0; request < 2; request++) {
          await withPluginRuntimeRegistryScope(ambient, invoke);
          expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
          expect(ownerCount()).toBe(0);
        }
        expect(fixture.readNormalizations()).toMatchObject([
          { owners: 1, workspaceDir: fixture.input.workspaceDir },
          { owners: 1, workspaceDir },
          { owners: 1, workspaceDir },
        ]);
        const first = respond.mock.calls[0]?.[1];
        expect(first).toMatchObject({
          groups: expect.arrayContaining([expect.objectContaining({ id: "mcp" })]),
        });
        expect(respond.mock.calls[1]?.[1]).toEqual(first);
        fixture.failNormalization();
        await withPluginRuntimeRegistryScope(ambient, invoke);
        expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
        expect(ownerCount()).toBe(0);
        expect(fixture.readNormalizations().at(-1)).toMatchObject({ owners: 1, workspaceDir });
        expect(normalizeAmbient).not.toHaveBeenCalled();
      });
    },
  );

  it("releases the dynamic owner after base inventory normalization fails", async () => {
    await withColdFixture(async (fixture) => {
      fixture.failNormalization();
      const { invoke, respond } = await createInventoryInvocation(fixture);
      await invoke();
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      expect(ownerCount()).toBe(0);
      expect(fixture.readNormalizations()).toMatchObject([
        { owners: 1, workspaceDir: fixture.input.workspaceDir },
      ]);
    });
  });

  it("keeps a catalog-only generation isolated after selected runtime preparation", async () => {
    await withColdFixture(async (fixture) => {
      const catalogLease = await acquireReadOnlyPreparedModelRuntime(fixture.input);
      try {
        const lease = await acquireReadOnlyPreparedModelRuntime({
          ...fixture.input,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider, modelId: pinnedId, agentId: "main" }],
        });
        try {
          expect(ownerCount()).toBe(2);
          const resolve = (snapshot: typeof lease.snapshot) =>
            resolveModelAsync(provider, pinnedId, fixture.input.agentDir, fixture.config, {
              ...snapshot.createStores(),
              agentId: "main",
              workspaceDir: fixture.input.workspaceDir,
              preparedModelRuntime: snapshot,
            });
          const resolved = await resolve(lease.snapshot);
          expect(resolved.model).toMatchObject({
            id: pinnedId,
            provider,
            api: "openai-completions",
          });
          expect(resolved.error).toBeUndefined();
          // Loading B must not lend hooks to A: a generation miss remains authoritative.
          const catalogResolved = await resolve(catalogLease.snapshot);
          expect(catalogResolved.model).toBeUndefined();
          expect(catalogResolved.error).toContain(`Unknown model: ${provider}/${pinnedId}`);
          expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(true);
          expect(pickerIds(fixture)).toEqual([curatedId]);
        } finally {
          lease.release();
        }
        expect(ownerCount()).toBe(1);
      } finally {
        catalogLease.release();
      }
    });
  });

  it.each([
    { policy: "global disable", plugins: { enabled: false } },
    { policy: "entry disable", plugins: { entries: { [pluginId]: { enabled: false } } } },
    { policy: "deny", plugins: { deny: [pluginId] } },
    { policy: "restrictive allow omission", plugins: { allow: ["unrelated-inventory-plugin"] } },
  ])("honors $policy despite an ambient competing provider", async ({ plugins }) => {
    await withColdFixture(async (fixture) => {
      const config: OpenClawConfig = {
        ...fixture.config,
        plugins: { ...fixture.config.plugins, ...plugins },
      };
      const ambientHook = vi.fn(() => {
        throw new Error("Ambient provider must not resolve the model");
      });
      const registry = createEmptyPluginRegistry();
      registry.providers.push({
        pluginId: "ambient-provider",
        source: "test",
        provider: {
          id: provider,
          label: "Ambient provider",
          auth: [],
          prepareDynamicModel: ambientHook,
          resolveDynamicModel: ambientHook,
        },
      });
      await withPluginRuntimeRegistryScope(registry, async () => {
        expect(resolveProviderRuntimePlugin({ provider, config })).toBeUndefined();
        const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
          ...fixture.inventoryParams,
          cfg: config,
        });
        expect(acquired.run((context) => context)).toEqual({});
        acquired.release();
      });
      expect(ambientHook).not.toHaveBeenCalled();
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(false);
    });
  });

  it.each([
    { modelId: "chat-unknown", throws: false },
    { modelId: throwingId, throws: true },
  ])("releases the selected owner when resolving $modelId", async ({ modelId, throws }) => {
    await withColdFixture(async (fixture) => {
      const resolution = acquireEffectiveToolInventoryRuntimeModelContext({
        ...fixture.inventoryParams,
        modelId,
      });
      if (throws) {
        await expect(resolution).rejects.toThrow("Provider preparation failed");
      } else {
        const acquired = await resolution;
        expect(acquired.run((context) => context)).toEqual({});
        acquired.release();
      }
      expect(isColdPluginRuntimeLoaded(fixture.selected)).toBe(true);
    });
  });
});
