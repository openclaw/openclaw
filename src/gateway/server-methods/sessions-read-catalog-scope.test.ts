import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../../agents/auth-profiles/path-resolve.native.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveProviderPolicySurface } from "../../plugins/provider-public-artifacts.js";
import type { ProviderThinkingProfile } from "../../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createPreparedGatewayModelCatalog,
  readPreparedGatewayModelCatalogMetadata,
} from "../server-model-catalog-view.js";
import {
  readPreparedGatewayModelCatalog,
  readPreparedGatewayModelCatalogBatch,
} from "../server-model-catalog.js";
import { agentsHandlers } from "./agents.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import { ownedSessionEntry, sessionReader } from "./sessions-read-fixture.test-support.js";
import type { GatewayRequestContext } from "./types.js";

async function seedSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { entries: { main: {}, work: {} } },
  };
  setRuntimeConfigSnapshot(config);
  for (const [agentId, updatedAt, id] of [
    ["main", 400, "owner@example.com"],
    ["work", 100, "viewer@example.com"],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId, sessionKey: `agent:${agentId}:active` },
      ownedSessionEntry(`${agentId}-active`, updatedAt, id),
    );
  }
  return config;
}

function reasonerCatalog(efforts = ["low", "high", "max"]): ModelCatalogEntry[] {
  return [
    {
      provider: "dynamic-router",
      id: "reasoner",
      name: "Reasoner",
      reasoning: true,
      compat: { supportedReasoningEfforts: efforts },
    },
  ];
}

function expectThinking(
  result: Awaited<ReturnType<typeof listSessions>>,
  agentId: string,
  levels: string[],
) {
  expect(result.sessions.find((row) => row.agentId === agentId)?.thinkingOptions).toEqual(levels);
}

function thinkingRegistry(
  providerId: string,
  resolveThinkingProfile: NonNullable<
    PluginRegistry["providers"][number]["provider"]["resolveThinkingProfile"]
  >,
): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: providerId,
    source: "test",
    provider: { id: providerId, label: providerId, auth: [], resolveThinkingProfile },
  });
  return registry;
}

function preparedOwner(
  config: OpenClawConfig,
  agentId: string,
  entries: ModelCatalogEntry[],
  pluginRegistry: PluginRegistry,
  readFullModelCatalog?: () => ModelCatalogSnapshot | undefined,
): PreparedModelRuntimeSnapshot {
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  return {
    catalogOwner: { agentId, workspaceDir },
    agentId,
    agentDir: resolveAgentDir(config, agentId),
    workspaceDir,
    config,
    observationConfig: config,
    isCurrent: () => true,
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    pluginRegistry,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries, routeVariants: [] },
    readFullModelCatalog,
    loadFullModelCatalog: vi.fn(() => {
      throw new Error("session listing must not start full catalog discovery");
    }),
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("session listing must not create execution stores");
    },
  };
}

function publishedCatalogContext(
  config: OpenClawConfig,
  owners: ReadonlyMap<string, PreparedModelRuntimeSnapshot>,
): GatewayRequestContext {
  prepareSharedAuthStoreOwnershipForNative();
  vi.spyOn(preparedRuntime, "getPreparedModelRuntimeSnapshot").mockImplementation((input) => {
    const owner = input.agentId ? owners.get(input.agentId) : undefined;
    return owner?.agentDir === input.agentDir ? owner : undefined;
  });
  const context: GatewayRequestContext = {
    ...requestContext(config),
    readPreparedGatewayModelCatalog: (options) =>
      readPreparedGatewayModelCatalog({ ...options, getConfig: () => context.getRuntimeConfig() }),
    readPreparedGatewayModelCatalogBatch: (agentIds) =>
      readPreparedGatewayModelCatalogBatch(agentIds, {
        getConfig: () => context.getRuntimeConfig(),
      }),
  };
  return context;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  resetAgentEventsForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it("refreshes runtime metadata when the prepared metadata owner changes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    config.agents = { ...config.agents, defaults: { model: "fixture-runtime/model" } };
    const entries: ModelCatalogEntry[] = [
      { provider: "fixture-runtime", id: "model", name: "Model" },
    ];
    const initialMetadataSnapshot = createPluginMetadataSnapshotFixture();
    let metadataSnapshot = initialMetadataSnapshot;
    let lastCatalog: ReturnType<typeof createPreparedGatewayModelCatalog> | undefined;
    const context = {
      ...requestContext(config),
      readPreparedGatewayModelCatalog: vi.fn(async () => {
        lastCatalog = createPreparedGatewayModelCatalog({ entries, metadataSnapshot });
        return lastCatalog;
      }),
    };
    const { list } = sessionReader(config, "owner@example.com", context);
    const request = { agentId: "main", archived: "all" as const, limit: 100 };
    const first = await list(request);
    const firstCatalog = lastCatalog;
    expect(first.sessions[0]?.agentRuntime?.id).not.toBe("fixture-runtime");
    context.readPreparedGatewayModelCatalog.mockClear();
    expect((await list(request)).sessions).toEqual(first.sessions);
    expect(context.readPreparedGatewayModelCatalog).not.toHaveBeenCalled();

    metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "fixture-owner", cliBackends: ["fixture-runtime"] }],
    });
    notifyPreparedModelRuntimePublication({ phase: "published" });
    const updated = await list(request);
    expect(updated.sessions[0]?.agentRuntime?.id).toBe("fixture-runtime");
    expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalled();
    expect(readPreparedGatewayModelCatalogMetadata(firstCatalog)).toBe(initialMetadataSnapshot);
    expect(readPreparedGatewayModelCatalogMetadata(lastCatalog)).toBe(metadataSnapshot);
  }));

it.each([
  { model: "gpt-5.6-sol", runtime: "codex", level: "ultra" },
  { model: "gpt-5.6-terra", runtime: "codex", level: "ultra" },
  { model: "gpt-5.6-luna", runtime: "codex", level: "max" },
  { model: "gpt-5.6-luna", runtime: "openclaw", level: "ultra" },
] as const)(
  "projects $model/$runtime from its prepared provider owner",
  ({ model, runtime, level }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents!.defaults = {
        model: { primary: `openai/${model}` },
        models: { [`openai/${model}`]: { agentRuntime: { id: runtime } } },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:active" },
        { thinkingLevel: level },
      );
      const entries: ModelCatalogEntry[] = [
        {
          provider: "openai",
          id: model,
          name: model,
          api: "openai-responses",
          reasoning: true,
          compat: {
            supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        },
      ];
      const owner = preparedOwner(
        config,
        "main",
        entries,
        thinkingRegistry("openai", resolveProviderPolicySurface("openai")!.resolveThinkingProfile!),
      );
      // The Gateway startup registry need not contain the model-selected provider.
      setActivePluginRegistry(createEmptyPluginRegistry());
      const context = publishedCatalogContext(config, new Map([["main", owner]]));
      const prepared = await context.readPreparedGatewayModelCatalog?.({ agentId: "main" });
      expect(readPreparedGatewayModelCatalogMetadata(prepared)).toBe(owner.metadataSnapshot);

      const result = await listSessions({
        client: identifiedClient("owner@example.com"),
        context,
        request: { agentId: "main", archived: "all" },
      });

      expect(result.sessions[0]).toMatchObject({ thinkingLevel: level });
      expect(result.sessions[0]?.thinkingOptions).toContain(level);
      expect(result.defaults.thinkingOptions).toContain(level);
      if (level === "max") {
        expect(result.sessions[0]?.thinkingOptions).toContain("ultra");
        expect(result.defaults.thinkingOptions).toContain("ultra");
      }
      expect(owner.loadFullModelCatalog).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('"metadataSnapshot":');
    }),
);

it("keeps identical catalogs owner-scoped across registry replacement and full catalog completion", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    config.agents!.defaults = {
      model: { primary: "dynamic-router/reasoner" },
      models: { "dynamic-router/reasoner": { agentRuntime: { id: "codex" } } },
    };
    const entries = reasonerCatalog();
    const profile = (level: "low" | "ultra"): ProviderThinkingProfile => ({
      levels: [{ id: "off" }, { id: level }],
      defaultLevel: level,
    });
    const mainRegistry = thinkingRegistry("dynamic-router", () => profile("ultra"));
    const workRegistry = thinkingRegistry("dynamic-router", () => profile("low"));
    const completed: { catalog?: ModelCatalogSnapshot } = {};
    let failMainCatalogRead = false;
    const mainOwner = preparedOwner(config, "main", entries, mainRegistry, () => {
      if (failMainCatalogRead) {
        throw new Error("main catalog owner replaced");
      }
      return completed.catalog;
    });
    const owners = new Map([
      ["main", mainOwner],
      ["work", preparedOwner(config, "work", entries, workRegistry)],
    ]);
    setActivePluginRegistry(mainRegistry);
    const context = publishedCatalogContext(config, owners);
    let currentConfig = config;
    context.getRuntimeConfig = () => currentConfig;
    const request = {
      client: identifiedClient("owner@example.com"),
      context,
      request: { archived: "all" as const },
    };
    const first = await listSessions(request);
    expectThinking(first, "main", ["off", "ultra"]);
    expectThinking(first, "work", ["off", "low", "ultra"]);
    const catalogs = vi.spyOn(context, "readPreparedGatewayModelCatalogBatch");
    expect((await listSessions(request)).sessions).toEqual(first.sessions);
    expect(catalogs).not.toHaveBeenCalled();
    const rosterResponse = vi.fn();
    await agentsHandlers["agents.list"]?.({
      params: {},
      client: request.client,
      context,
      respond: rosterResponse,
    } as never);
    expect(rosterResponse.mock.calls[0]?.[0]).toBe(true);
    const roster = rosterResponse.mock.calls[0]?.[1] as AgentsListResult;
    expect(roster.agents.find((row) => row.id === "main")?.thinkingOptions).toEqual([
      "off",
      "ultra",
    ]);
    expect(roster.agents.find((row) => row.id === "work")?.thinkingOptions).toEqual([
      "off",
      "low",
      "ultra",
    ]);

    // An empty replacement restores the generic native ladder without disabling harness Ultra.
    owners.set("main", { ...mainOwner, pluginRegistry: createEmptyPluginRegistry() });
    notifyPreparedModelRuntimePublication({ phase: "published" });
    const replaced = await listSessions(request);
    expectThinking(replaced, "main", ["off", "minimal", "low", "medium", "high", "max", "ultra"]);
    expectThinking(replaced, "work", ["off", "low", "ultra"]);

    failMainCatalogRead = true;
    notifyPreparedModelRuntimePublication({
      phase: "catalog-failed",
    });
    const partial = await listSessions(request);
    expectThinking(partial, "work", ["off", "low", "ultra"]);
    failMainCatalogRead = false;

    completed.catalog = { entries: [{ ...entries[0]!, reasoning: false }], routeVariants: [] };
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    const promoted = await listSessions(request);
    expectThinking(promoted, "main", ["off"]);
    expect(mainOwner.loadFullModelCatalog).not.toHaveBeenCalled();

    const workAgentDir = `${resolveAgentDir(config, "work")}-replacement`;
    config.agents!.entries = {
      main: {},
      work: { agentDir: workAgentDir },
    };
    owners.set("work", preparedOwner(config, "work", entries, mainRegistry));
    setRuntimeConfigSnapshot(config);
    const changedRoster = await listSessions(request);
    expectThinking(changedRoster, "work", ["off", "ultra"]);

    const nextConfig: OpenClawConfig = {
      ...config,
      agents: {
        ...config.agents,
        entries: {
          main: {},
          work: { agentDir: `${workAgentDir}-next` },
        },
      },
    };
    currentConfig = nextConfig;
    owners.set("work", preparedOwner(nextConfig, "work", entries, workRegistry));
    setRuntimeConfigSnapshot(nextConfig);
    const changedConfig = await listSessions(request);
    expectThinking(changedConfig, "work", ["off", "low", "ultra"]);
  }));

it.each([false, true])("keeps completed catalogs owner-scoped (agent filter=%s)", (scoped) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    config.agents = {
      ...config.agents,
      defaults: { model: { primary: "dynamic-router/reasoner" } },
    };
    const mainCatalog = reasonerCatalog();
    const workCatalog = reasonerCatalog(["medium"]);
    const context = {
      ...requestContext(config),
      readPreparedGatewayModelCatalog: vi.fn(async (options?: { agentId?: string }) => ({
        entries: options?.agentId === "work" ? workCatalog : mainCatalog,
      })),
    };
    if (scoped) {
      await initializeSessionReadContext(context);
      context.readPreparedGatewayModelCatalog.mockClear();
    }
    const { list } = sessionReader(config, "owner@example.com", context);
    const result = await list({
      archived: "all",
      limit: 100,
      ...(scoped ? { agentId: "main" } : {}),
    });
    const mainRow = result.sessions.find((row) => row.agentId === "main");
    expect(mainRow?.thinkingOptions).toEqual(expect.arrayContaining(["off", "low", "high", "max"]));
    if (scoped) {
      expect(result.sessions.map((row) => row.agentId)).toEqual(["main"]);
      expect(context.readPreparedGatewayModelCatalog).not.toHaveBeenCalled();
    } else {
      const workRow = result.sessions.find((row) => row.agentId === "work");
      expect(workRow?.thinkingOptions).toEqual(expect.arrayContaining(["off", "medium"]));
      expect(workRow?.thinkingOptions).not.toEqual(expect.arrayContaining(["low", "high", "max"]));
      for (const agentId of ["main", "work"]) {
        expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalledWith({ agentId });
      }
    }
  }),
);
