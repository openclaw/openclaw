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
let config = createSubagentSpawnTestConfig(os.tmpdir());
let persistedStore: Record<string, Record<string, unknown>> | undefined;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      loadSessionStoreMock,
      updateSessionStoreMock,
      workspaceDir: os.tmpdir(),
    }));
  });
  beforeEach(() => {
    resetSubagentRegistryForTests();
    config = createSubagentSpawnTestConfig(os.tmpdir());
    callGatewayMock.mockReset();
    loadSessionStoreMock.mockReset().mockReturnValue({});
    updateSessionStoreMock.mockReset();
    persistedStore = undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  it.each(["user", "auto"] as const)(
    "persists a %s-selected model separately from its auth profile",
    async (source) => {
      const model = "openai/gpt-5.6-luna@openai:test-profile";
      if (source === "auto") {
        config = createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: { defaults: { workspace: os.tmpdir(), subagents: { model } } },
        });
      }
      const result = await spawnSubagentDirect(
        { task: "test", ...(source === "user" ? { model } : {}) },
        { agentSessionKey: "agent:main:main", agentChannel: "guildchat" },
      );
      expect(result.status).toBe("accepted");
      expect(result.resolvedModel).toBe("openai/gpt-5.6-luna");
      expectPersistedRuntimeModel({
        persistedStore,
        sessionKey: /^agent:main:subagent:/,
        provider: "openai",
        model: "gpt-5.6-luna",
        overrideSource: source,
      });
      const [, entry] = Object.entries(persistedStore ?? {})[0] ?? [];
      expect(entry).toMatchObject({
        authProfileOverride: "openai:test-profile",
        authProfileOverrideSource: "user",
      });
      if (source === "auto") {
        expect(entry).toMatchObject({
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "gpt-5.6-luna",
        });
      }
    },
  );

  it.each([
    { source: "active", model: "custom/model" },
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

  it.each([
    { name: "different model", model: "custom/model-b", parentMode: true, expected: undefined },
    {
      name: "same model alias explicit off",
      model: "same-model",
      parentMode: false,
      expected: false,
    },
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
    async ({ model, parentMode, override, savedModel, expected }) => {
      config = createSubagentSpawnTestConfig(os.tmpdir(), {
        tools: { swarm: { enabled: true } },
        agents: {
          defaults: {
            workspace: os.tmpdir(),
            model: { primary: "custom/model-a" },
            models: {
              "custom/model-a": { alias: "same-model", params: { fastMode: true } },
              "custom/model-b": { params: { fastMode: false } },
            },
          },
        },
      });
      loadSessionStoreMock.mockReturnValue({
        "agent:main:main": {
          sessionId: "fast-mode-parent",
          providerOverride: "custom",
          modelOverride: savedModel ?? "model-a",
          fastMode: parentMode,
        },
      });
      const result = await spawnSubagentDirect(
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
