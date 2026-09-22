import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentsListResult,
  SessionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
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
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../session-utils.types.js";
import { agentsHandlers } from "./agents.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const { sessionReadHandlers } = await import("./sessions-read.js");

async function listSessions(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  request: SessionsListParams;
}) {
  await initializeSessionReadContext(params.context);
  const responses: Parameters<RespondFn>[] = [];
  await sessionReadHandlers["sessions.list"]?.({
    req: { type: "req", id: "session-list-test", method: "sessions.list" },
    params: params.request,
    client: params.client,
    context: params.context,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1] as {
    count: number;
    defaults: GatewaySessionsDefaults;
    nextOffset: number | null;
    sessions: GatewaySessionRow[];
    totalCount: number;
  };
}

async function seedSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
  };
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: "agent:main:active" },
    {
      sessionId: "main-active",
      updatedAt: 400,
      createdActor: { type: "human", source: "profile", id: "owner@example.com" },
      visibility: "shared",
    },
  );
  await upsertSessionEntryCore(
    { agentId: "work", sessionKey: "agent:work:active" },
    {
      sessionId: "work-active",
      updatedAt: 100,
      createdActor: { type: "human", source: "profile", id: "viewer@example.com" },
      visibility: "shared",
    },
  );
  return config;
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

function preparedOwner(params: {
  config: OpenClawConfig;
  agentId: string;
  entries: ModelCatalogEntry[];
  pluginRegistry: PluginRegistry;
  readFullModelCatalog?: () => ModelCatalogSnapshot | undefined;
}): PreparedModelRuntimeSnapshot {
  const workspaceDir = resolveAgentWorkspaceDir(params.config, params.agentId);
  return {
    catalogOwner: { agentId: params.agentId, workspaceDir },
    agentId: params.agentId,
    agentDir: resolveAgentDir(params.config, params.agentId),
    workspaceDir,
    config: params.config,
    observationConfig: params.config,
    isCurrent: () => true,
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    pluginRegistry: params.pluginRegistry,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: params.entries, routeVariants: [] },
    readFullModelCatalog: params.readFullModelCatalog,
    loadFullModelCatalog: vi.fn(() => {
      throw new Error("session listing must not start full catalog discovery");
    }),
    configuredRuntimeModels: [],
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

describe("sessions.list catalog scoping", () => {
  it("refreshes runtime metadata when the prepared metadata owner changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
      const client = identifiedClient("owner@example.com");
      const request = { agentId: "main", archived: "all" as const, limit: 100 };
      const first = await listSessions({ client, context, request });
      const firstCatalog = lastCatalog;
      expect(first.sessions[0]?.agentRuntime?.id).not.toBe("fixture-runtime");
      context.readPreparedGatewayModelCatalog.mockClear();
      expect((await listSessions({ client, context, request })).sessions).toEqual(first.sessions);
      expect(context.readPreparedGatewayModelCatalog).not.toHaveBeenCalled();

      metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "fixture-owner", cliBackends: ["fixture-runtime"] }],
      });
      notifyPreparedModelRuntimePublication({ phase: "published" });
      const updated = await listSessions({ client, context, request });
      expect(updated.sessions[0]?.agentRuntime?.id).toBe("fixture-runtime");
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalled();
      expect(readPreparedGatewayModelCatalogMetadata(firstCatalog)).toBe(initialMetadataSnapshot);
      expect(readPreparedGatewayModelCatalogMetadata(lastCatalog)).toBe(metadataSnapshot);
    });
  });

  it.each([
    { model: "gpt-5.6-sol", runtime: "codex", level: "ultra" },
    { model: "gpt-5.6-terra", runtime: "codex", level: "ultra" },
    { model: "gpt-5.6-luna", runtime: "codex", level: "max" },
    { model: "gpt-5.6-luna", runtime: "openclaw", level: "ultra" },
  ] as const)(
    "projects $model/$runtime from its prepared provider owner",
    async ({ model, runtime, level }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
        const owner = preparedOwner({
          config,
          agentId: "main",
          entries,
          pluginRegistry: thinkingRegistry(
            "openai",
            resolveProviderPolicySurface("openai")!.resolveThinkingProfile!,
          ),
        });
        // The Gateway startup registry need not contain the model-selected provider.
        setActivePluginRegistry(createEmptyPluginRegistry());
        const context = publishedCatalogContext(config, new Map([["main", owner]]));
        const prepared = await context.readPreparedGatewayModelCatalog?.({ agentId: "main" });
        expect(readPreparedGatewayModelCatalogMetadata(prepared)).toBe(owner.metadataSnapshot);
        expect(new Set(Reflect.ownKeys(prepared ?? {}))).toEqual(
          new Set(["entries", "pluginRegistry", "routeVariants"]),
        );

        const result = await listSessions({
          client: identifiedClient("owner@example.com"),
          context,
          request: { agentId: "main", archived: "all" },
        });

        expect(result.sessions[0]).toMatchObject({ thinkingLevel: level });
        expect(result.sessions[0]?.thinkingOptions).toContain(level);
        expect(result.defaults.thinkingOptions).toContain(level);
        if (level === "max") {
          expect(result.sessions[0]?.thinkingOptions).not.toContain("ultra");
          expect(result.defaults.thinkingOptions).not.toContain("ultra");
        }
        expect(owner.loadFullModelCatalog).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('"metadataSnapshot":');
      });
    },
  );

  it("keeps identical catalogs owner-scoped across registry replacement and full catalog completion", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents!.defaults = {
        model: { primary: "dynamic-router/reasoner" },
        models: { "dynamic-router/reasoner": { agentRuntime: { id: "codex" } } },
      };
      const entries: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        },
      ];
      const profile = (level: "low" | "ultra"): ProviderThinkingProfile => ({
        levels: [{ id: "off" }, { id: level }],
        defaultLevel: level,
      });
      const mainRegistry = thinkingRegistry("dynamic-router", () => profile("ultra"));
      const workRegistry = thinkingRegistry("dynamic-router", () => profile("low"));
      const completed: { catalog?: ModelCatalogSnapshot } = {};
      let failMainCatalogRead = false;
      const mainOwner = preparedOwner({
        config,
        agentId: "main",
        entries,
        pluginRegistry: mainRegistry,
        readFullModelCatalog: () => {
          if (failMainCatalogRead) {
            throw new Error("main catalog owner replaced");
          }
          return completed.catalog;
        },
      });
      const owners = new Map([
        ["main", mainOwner],
        ["work", preparedOwner({ config, agentId: "work", entries, pluginRegistry: workRegistry })],
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
      expect(first.sessions.find((row) => row.agentId === "main")?.thinkingOptions).toEqual([
        "off",
        "ultra",
      ]);
      expect(first.sessions.find((row) => row.agentId === "work")?.thinkingOptions).toEqual([
        "off",
        "low",
      ]);
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
      ]);

      // An empty replacement is authoritative even while the global registry still offers Ultra.
      owners.set("main", { ...mainOwner, pluginRegistry: createEmptyPluginRegistry() });
      notifyPreparedModelRuntimePublication({ phase: "published" });
      const replaced = await listSessions(request);
      expect(
        replaced.sessions.find((row) => row.agentId === "main")?.thinkingOptions,
      ).not.toContain("ultra");
      expect(replaced.sessions.find((row) => row.agentId === "work")?.thinkingOptions).toEqual([
        "off",
        "low",
      ]);

      failMainCatalogRead = true;
      notifyPreparedModelRuntimePublication({
        phase: "catalog-failed",
        error: new Error("main catalog owner replaced"),
      });
      const partial = await listSessions(request);
      expect(partial.sessions.find((row) => row.agentId === "work")?.thinkingOptions).toEqual([
        "off",
        "low",
      ]);
      failMainCatalogRead = false;

      completed.catalog = { entries: [{ ...entries[0]!, reasoning: false }], routeVariants: [] };
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      const promoted = await listSessions(request);
      expect(promoted.sessions.find((row) => row.agentId === "main")?.thinkingOptions).toEqual([
        "off",
      ]);
      expect(mainOwner.loadFullModelCatalog).not.toHaveBeenCalled();

      const workAgentDir = `${resolveAgentDir(config, "work")}-replacement`;
      config.agents!.list = [
        { id: "main", default: true },
        { id: "work", agentDir: workAgentDir },
      ];
      owners.set("work", {
        ...preparedOwner({ config, agentId: "work", entries, pluginRegistry: mainRegistry }),
        agentDir: workAgentDir,
      });
      setRuntimeConfigSnapshot(config);
      const changedRoster = await listSessions(request);
      expect(changedRoster.sessions.find((row) => row.agentId === "work")?.thinkingOptions).toEqual(
        ["off", "ultra"],
      );

      const nextConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          list: [
            { id: "main", default: true },
            { id: "work", agentDir: `${workAgentDir}-next` },
          ],
        },
      };
      currentConfig = nextConfig;
      owners.set("work", {
        ...preparedOwner({
          config: nextConfig,
          agentId: "work",
          entries,
          pluginRegistry: workRegistry,
        }),
        agentDir: `${workAgentDir}-next`,
      });
      setRuntimeConfigSnapshot(nextConfig);
      const changedConfig = await listSessions(request);
      expect(changedConfig.sessions.find((row) => row.agentId === "work")?.thinkingOptions).toEqual(
        ["off", "low"],
      );
    });
  });

  it("keeps unscoped listings owner-scoped when agents have distinct completed catalogs", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents = {
        ...config.agents,
        defaults: { model: { primary: "dynamic-router/reasoner" } },
      };
      const mainCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        },
      ];
      const workCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["medium"] },
        },
      ];
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: vi.fn(async (options?: { agentId?: string }) => ({
          entries: options?.agentId === "work" ? workCatalog : mainCatalog,
        })),
      };
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };

      const result = await listSessions({ client, context, request });

      const mainRow = result.sessions.find((session) => session.agentId === "main");
      const workRow = result.sessions.find((session) => session.agentId === "work");
      expect(mainRow).toBeDefined();
      expect(workRow).toBeDefined();
      expect(mainRow?.thinkingOptions).toEqual(
        expect.arrayContaining(["off", "low", "high", "max"]),
      );
      expect(workRow?.thinkingOptions).toEqual(expect.arrayContaining(["off", "medium"]));
      expect(workRow?.thinkingOptions).not.toEqual(expect.arrayContaining(["low", "high", "max"]));
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalledWith({
        agentId: "main",
      });
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalledWith({
        agentId: "work",
      });
    });
  });

  it("presents the requested agent's retained catalog without reacquiring it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents = {
        ...config.agents,
        defaults: { model: { primary: "dynamic-router/reasoner" } },
      };
      const mainCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        },
      ];
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: vi.fn(async () => ({ entries: mainCatalog })),
      };
      const client = identifiedClient("owner@example.com");
      await initializeSessionReadContext(context);
      context.readPreparedGatewayModelCatalog.mockClear();

      const result = await listSessions({
        client,
        context,
        request: { agentId: "main", archived: "all" as const, limit: 100 },
      });

      expect(result.sessions.map((session) => session.agentId)).toEqual(["main"]);
      expect(result.sessions[0]?.thinkingOptions).toEqual(
        expect.arrayContaining(["off", "low", "high", "max"]),
      );
      expect(context.readPreparedGatewayModelCatalog).not.toHaveBeenCalled();
    });
  });
});
