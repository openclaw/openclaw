// Subagent spawn model-session tests verify runtime model metadata is persisted
// before a child agent run starts.
import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();

let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      loadSessionStoreMock,
      updateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    loadSessionStoreMock.mockReset().mockReturnValue({});
    updateSessionStoreMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);

    updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("persists runtime model fields on the child session before starting the run", async () => {
    // The child run reads model/provider from session state, so persistence must
    // happen before the gateway accepts the agent request.
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      if (opts.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "test",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.modelApplied).toBe(true);
    expect(result.resolvedModel).toBe("openai/gpt-5.4");
    expect(result.resolvedProvider).toBe("openai");
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
  });

  it("persists an explicit auth profile separately from the child model id", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "test",
        model: "openai/gpt-5.6-luna@openai:test-profile",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.resolvedModel).toBe("openai/gpt-5.6-luna");
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai",
      model: "gpt-5.6-luna",
      overrideSource: "user",
    });
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry?.authProfileOverride).toBe("openai:test-profile");
    expect(persistedEntry?.authProfileOverrideSource).toBe("user");
  });

  it.each([
    { source: "active", model: "custom/model" },
    { source: "persisted", model: "custom/model" },
    { source: "persisted", model: "middle" },
  ])("preserves the $source resolved model $model in child state", async ({ source, model }) => {
    const [{ createPluginMetadataSnapshotFixture }, { withPluginRuntimeGenerationScope }] =
      await Promise.all([
        import("../../../plugins/plugin-metadata.test-support.js"),
        import("../../../plugins/runtime/generation-scope.js"),
      ]);
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "model-identity-fixture",
          providers: ["custom"],
          modelIdNormalization: { providers: { custom: { aliases: { middle: "final" } } } },
        },
      ],
    });
    loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        sessionId: "model-identity-parent",
        providerOverride: "custom",
        modelOverride: model,
        modelOverrideRouteResolution: "resolved",
      },
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      spawnSubagentDirect(
        { task: "preserve the selected model" },
        {
          agentSessionKey: "agent:main:main",
          ...(source === "active" ? { requesterModel: { provider: "custom", model } } : {}),
        },
      ),
    );

    expect(result.status).toBe("accepted");
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "custom",
      model,
      overrideSource: "auto",
    });
    const [, entry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(entry?.modelOverrideRouteResolution).toBe("resolved");
    expect(result.resolvedModel).toBe(`custom/${model}`);
  });

  it("persists self-origin metadata for auto-selected subagent models", async () => {
    const dedicatedUpdateSessionStoreMock = vi.fn();
    const {
      resetSubagentRegistryForTests: resetForAutoModelTest,
      spawnSubagentDirect: spawnWithAutoModel,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
              model: { primary: "openai/gpt-5.5" },
              subagents: { model: "gpt-5.4" },
            },
          },
        }),
      updateSessionStoreMock: dedicatedUpdateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    });
    resetForAutoModelTest();
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(dedicatedUpdateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnWithAutoModel(
      {
        task: "test",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry?.modelOverrideSource).toBe("auto");
    expect(persistedEntry?.modelOverrideFallbackOriginProvider).toBe("openai");
    expect(persistedEntry?.modelOverrideFallbackOriginModel).toBe("gpt-5.4");
  });

  it("persists an inherited auth profile separately from the child model id", async () => {
    const dedicatedUpdateSessionStoreMock = vi.fn();
    const {
      resetSubagentRegistryForTests: resetForProfileTest,
      spawnSubagentDirect: spawnWithProfile,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
              model: { primary: "openai/gpt-5.6-luna@openai:test-profile" },
            },
          },
        }),
      updateSessionStoreMock: dedicatedUpdateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    });
    resetForProfileTest();
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(dedicatedUpdateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnWithProfile(
      { task: "test" },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.resolvedModel).toBe("openai/gpt-5.6-luna");
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai",
      model: "gpt-5.6-luna",
      overrideSource: "auto",
    });
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry?.authProfileOverride).toBe("openai:test-profile");
    expect(persistedEntry?.authProfileOverrideSource).toBe("user");
  });

  it.each([
    { name: "different model", model: "custom/model-b", parentMode: true, expected: undefined },
    {
      name: "same model explicit off",
      model: "custom/model-a",
      parentMode: false,
      expected: false,
    },
    { name: "same model alias", model: "same-model", parentMode: false, expected: false },
    {
      name: "configured child",
      configuredModel: "custom/model-b",
      parentMode: true,
      expected: undefined,
    },
    { name: "case-distinct model", model: "custom/MODEL-A", parentMode: true, expected: undefined },
    { name: "different provider", model: "other/model-a", parentMode: true, expected: undefined },
    {
      name: "explicit child off",
      model: "custom/model-b",
      parentMode: true,
      override: false,
      expected: false,
    },
    {
      name: "explicit child auto",
      model: "custom/model-b",
      parentMode: true,
      override: "auto" as const,
      expected: "auto",
    },
    {
      name: "active model differs from saved selection",
      model: "custom/model-a",
      savedModel: "model-b",
      expected: true,
    },
  ])(
    "scopes inherited Fast mode: $name",
    async ({ model, configuredModel, parentMode, override, savedModel, expected }) => {
      const { spawnSubagentDirect: spawn } = await loadSubagentSpawnModuleForTest({
        callGatewayMock,
        loadSessionStoreMock,
        updateSessionStoreMock,
        getRuntimeConfig: () =>
          createSubagentSpawnTestConfig(os.tmpdir(), {
            tools: { swarm: { enabled: true } },
            agents: {
              defaults: {
                workspace: os.tmpdir(),
                model: { primary: "custom/model-a" },
                models: {
                  "custom/model-a": { alias: "same-model", params: { fastMode: true } },
                  "custom/model-b": { params: { fastMode: false } },
                },
                ...(configuredModel ? { subagents: { model: configuredModel } } : {}),
              },
            },
          }),
        workspaceDir: os.tmpdir(),
      });
      loadSessionStoreMock.mockReturnValue({
        "agent:main:main": {
          sessionId: "fast-mode-parent",
          providerOverride: "custom",
          modelOverride: savedModel ?? "model-a",
          fastMode: parentMode,
        },
      });
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });

      const result = await spawn(
        { task: "test", model, fastMode: override },
        {
          agentSessionKey: "agent:main:main",
          requesterModel: { provider: "custom", model: "model-a" },
        },
      );

      expect(result.status).toBe("accepted");
      const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
      expect(persistedEntry).toBeDefined();
      expect(persistedEntry?.fastMode).toBe(expected);
    },
  );
});
