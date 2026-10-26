import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import * as ttsSettings from "../tts/tts-settings.js";
import { configFor } from "./model-auth.fixtures.test-support.js";
import * as preparedModelCatalog from "./prepared-model-catalog.js";
import { prepareConfiguredModelAliases } from "./prepared-model-runtime.configured-completion.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";
import * as systemPrompt from "./system-prompt.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function modelConfig(
  aliases: Record<string, string>,
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"] = {},
  config: OpenClawConfig = { plugins: { enabled: false } },
): OpenClawConfig {
  const models = Object.fromEntries(
    Object.entries(aliases).map(([ref, alias]) => [ref, { alias }]),
  );
  return {
    ...config,
    agents: { ...config.agents, defaults: { ...defaults, models } },
  };
}

function unexpectedRuntimeWork(): never {
  throw new Error("Prompt rendering must not select models, create stores, or discover providers");
}

function preparedOwner(
  config: OpenClawConfig,
  modelIds: string[],
  agentId = "main",
  metadataSnapshot = createPluginMetadataSnapshotFixture(),
  provider = "fixture",
) {
  const configuredRuntimeModels = modelIds.map((modelId) => ({
    provider,
    modelId,
    model: makeProviderModelFixture({
      provider,
      id: modelId,
      api: "openai-responses",
      baseUrl: "https://models.example.test/v1",
    }),
  }));
  const entries = configuredRuntimeModels.map(({ provider: modelProvider, modelId, model }) => ({
    provider: modelProvider,
    id: modelId,
    name: model.name,
  }));
  const templateAuthStorage = AuthStorage.inMemory({});
  const configuredModelAliases = prepareConfiguredModelAliases(
    {
      input: { config, agentId, agentDir: `/tmp/openclaw/${agentId}/agent` },
      env: {},
      authStore: { version: 1, profiles: {} },
      templateAuthStorage,
      credentials: {},
      providerIds: [provider],
      configuredModelRefs: modelIds.map((modelId) => ({ provider, modelId })),
      configuredRuntimeModels,
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
    },
    {
      pluginMetadataSnapshot: metadataSnapshot,
      inlineProviderModels: [],
      remoteCatalog: null,
      configuredCatalogEntries: entries,
    },
    ModelRegistry.inMemory(templateAuthStorage),
    configuredRuntimeModels,
  );
  return {
    isCurrent: vi.fn(() => true),
    configuredModelAliases,
    findConfiguredRuntimeModel: unexpectedRuntimeWork,
    createStores: vi.fn(unexpectedRuntimeWork),
    loadFullModelCatalog: vi.fn(unexpectedRuntimeWork),
  };
}

function buildPrompt(
  params: Omit<Parameters<typeof buildConfiguredAgentSystemPrompt>[0], "workspaceDir">,
): string {
  return buildConfiguredAgentSystemPrompt({
    workspaceDir: "/tmp/openclaw",
    ...params,
  });
}

function reasoningConfig(
  text?: boolean,
  native?: boolean,
  discordNative?: boolean,
): OpenClawConfig {
  return {
    commands: { text, native },
    ...(discordNative === undefined
      ? {}
      : { channels: { discord: { commands: { native: discordNative } } } }),
  };
}

describe("buildConfiguredAgentSystemPrompt", () => {
  it.each<[string, string, OpenClawConfig, boolean]>([
    ["disabled routes", "discord", reasoningConfig(false, false), false],
    ["channel disables native", "discord", reasoningConfig(false, true, false), false],
    ["channel enables native", "discord", reasoningConfig(false, false, true), true],
    ["native auto on", "discord", reasoningConfig(false), true],
    ["native auto off", "slack", reasoningConfig(false), false],
    ["text enabled", "discord", reasoningConfig(undefined, false), true],
    ["text-only surface", "webchat", reasoningConfig(false, false), true],
  ])("renders reasoning command guidance for %s", (_name, channel, config, enabled) => {
    const registry = createTestRegistry(
      ["discord", "slack"].map((id) => ({
        pluginId: id,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id,
            capabilities: { nativeCommands: true, chatTypes: ["direct"] },
          }),
          commands: { nativeCommandsAutoEnabled: id === "discord" },
        },
      })),
    );
    const previous = captureActivePluginRegistrySnapshot();
    onTestFinished(() => restoreActivePluginRegistrySnapshot(previous));
    // Command routing consumes process-level channel metadata.
    setActivePluginRegistry(registry);
    const prompt = buildPrompt({
      config,
      runtimeInfo: { channel },
      reasoningLevel: "stream",
    });
    expect(prompt).toContain("Reasoning=stream; hidden unless on/stream.");
    expect(prompt.includes("Toggle /reasoning")).toBe(enabled);
    expect(prompt.includes("/status shows when enabled.")).toBe(enabled);
  });

  it.each([{ toolNames: [] }, { toolNames: ["gateway"] }])(
    "does not recommend disabled update or restart commands with tools $toolNames",
    ({ toolNames }) => {
      const disabled = buildPrompt({
        toolNames,
        config: { commands: { restart: false } },
      });
      expect(disabled).not.toContain("`/update`");
      expect(disabled).not.toContain("`/restart`");
      expect(disabled).toContain("maintenance tools, not exec or detached jobs");
      expect(disabled).toContain("Toggle /reasoning; /status shows when enabled.");
      const enabled = buildPrompt({ toolNames, config: {} });
      expect(enabled).toContain("`/update`");
    },
  );

  it.each(["minimal", "none"] as const)(
    "skips full-only preparation in %s mode and refreshes the next full prompt",
    (promptMode) => {
      const hint = vi
        .spyOn(ttsSettings, "buildTtsSystemPromptHint")
        .mockReturnValue("Fixture first voice guidance.");
      const config = modelConfig({ "fixture/model": "Before" });
      const owner = preparedOwner(config, ["model"]);
      const params = {
        config,
        preparedModelRuntime: owner,
        includeMemorySection: false,
      };
      const full = buildPrompt(params);
      expect(full).toContain("- Before: fixture/model");
      expect(full).toContain("Fixture first voice guidance.");
      hint.mockClear();
      owner.isCurrent.mockClear();
      const reduced = buildPrompt({ ...params, promptMode });
      expect(hint).not.toHaveBeenCalled();
      expect(owner.isCurrent).not.toHaveBeenCalled();
      expect(reduced).not.toContain("## Model Aliases");
      expect(reduced).not.toContain("## Voice (TTS)");
      expect(buildPrompt(params)).toBe(full);

      owner.isCurrent.mockReturnValue(false);
      const nextConfig = modelConfig({ "fixture/model": "After" });
      params.config = nextConfig;
      params.preparedModelRuntime = preparedOwner(nextConfig, ["model"]);
      hint.mockReturnValue("Fixture current voice guidance.");
      hint.mockClear();
      expect(buildPrompt({ ...params, promptMode })).toBe(reduced);
      expect(hint).not.toHaveBeenCalled();
      const refreshed = buildPrompt(params);
      expect(refreshed).toContain("- After: fixture/model");
      expect(refreshed).not.toContain("- Before: fixture/model");
      expect(refreshed).toContain("Fixture current voice guidance.");
      expect(refreshed).not.toContain("Fixture first voice guidance.");
      expect(owner.createStores).not.toHaveBeenCalled();
      expect(owner.loadFullModelCatalog).not.toHaveBeenCalled();
    },
  );

  it.each<{
    name: string;
    config: OpenClawConfig;
    modelIds?: string[];
    agentId?: string;
    provider?: string;
    metadata?: ReturnType<typeof createPluginMetadataSnapshotFixture>;
    alias: string;
    model?: string;
    excluded?: string[];
  }>([
    ...(["model", "provider"] as const).map((kind) => {
      const provider = kind === "model" ? "fixture" : "legacy-fixture";
      const authoredRef = kind === "model" ? "fixture/legacy" : "legacy-fixture/current";
      return {
        name: `authored ${kind} alias`,
        provider,
        metadata: createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "fixture",
              providers: ["fixture"],
              ...(kind === "model"
                ? {
                    modelIdNormalization: {
                      providers: { fixture: { aliases: { legacy: "current" } } },
                    },
                  }
                : { modelCatalog: { aliases: { "legacy-fixture": { provider: "fixture" } } } }),
            },
          ],
        }),
        config: modelConfig(
          { [authoredRef]: "Friendly" },
          { model: `${provider}/current`, modelPolicy: { allow: ["Friendly"] } },
          {},
        ),
        alias: "Friendly",
      };
    }),
    {
      name: "unlisted custom alias",
      modelIds: [],
      alias: "Custom",
      model: "unlisted",
      config: modelConfig(
        { "fixture/unlisted": "Custom" },
        {},
        {
          plugins: { enabled: false },
          ...configFor("fixture", "https://custom.invalid/v1", { api: "openai-completions" }),
        },
      ),
    },
    ...(["agent-owned", "inherited"] as const).map((policyOwner) => ({
      name: `${policyOwner} manual policy`,
      agentId: "writer",
      modelIds: ["current", "other"],
      alias: "Writer",
      excluded: ["- Shared:", "- Other:"],
      config: modelConfig(
        { "fixture/current": "Shared", "fixture/other": "Other" },
        {
          model: "fixture/current",
          modelPolicy: policyOwner === "inherited" ? { allow: ["Shared"] } : undefined,
        },
        {
          plugins: { enabled: false },
          agents: {
            entries: {
              writer: {
                modelPolicy:
                  policyOwner === "agent-owned" ? { allow: ["fixture/current"] } : undefined,
                models: {
                  "fixture/current": { alias: "Writer" },
                  ...(policyOwner === "inherited" ? { "fixture/other": { alias: "Shared" } } : {}),
                },
              },
            },
          },
        },
      ),
    })),
    {
      name: "shared bare alias",
      modelIds: ["current", "other"],
      alias: "Shared",
      model: "other",
      excluded: ["- Shared: fixture/current"],
      config: modelConfig(
        { "fixture/current": "Shared", "fixture/other": "Shared" },
        { model: "fixture/current" },
      ),
    },
  ])(
    "publishes only the supported target for $name",
    ({
      config,
      modelIds = ["current"],
      agentId = "main",
      provider = "fixture",
      metadata,
      alias,
      model = "current",
      excluded = [],
    }) => {
      const owner = preparedOwner(config, modelIds, agentId, metadata, provider);
      const prompt = buildPrompt({
        config,
        agentId,
        preparedModelRuntime: owner,
      });
      expect(prompt).toContain(`- ${alias}: ${provider}/${model}`);
      for (const text of excluded) {
        expect(prompt).not.toContain(text);
      }
      expect(owner.configuredModelAliases).toEqual([{ provider, model, alias }]);
    },
  );

  it("renders only current supplied aliases without ambient lookup or repeated discovery", () => {
    const config = modelConfig(
      {
        "fixture/current": "Current",
        "fixture/unsupported": "Unavailable",
      },
      { model: "fixture/current" },
    );
    const owner = preparedOwner(config, ["current"], "writer");
    const lookup = vi
      .spyOn(preparedModelCatalog, "getPreparedModelCatalogOwnerSnapshot")
      .mockImplementation(unexpectedRuntimeWork);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const params = { config, agentId: "writer" };
    expect(buildPrompt(params)).not.toContain("## Model Aliases");
    for (let index = 0; index < 3; index++) {
      const prompt = buildPrompt({ ...params, preparedModelRuntime: owner });
      expect(prompt).toContain("- Current: fixture/current");
      expect(prompt).not.toContain("Unavailable");
      expect(prompt).not.toContain("fixture/unsupported");
    }
    owner.isCurrent.mockReturnValue(false);
    expect(buildPrompt({ ...params, preparedModelRuntime: owner })).not.toContain(
      "## Model Aliases",
    );
    const replacementConfig = modelConfig({ "fixture/current": "Replacement" });
    expect(
      buildPrompt({
        ...params,
        config: replacementConfig,
        preparedModelRuntime: preparedOwner(replacementConfig, ["current"], "writer"),
      }),
    ).toContain("- Replacement: fixture/current");
    expect(lookup).not.toHaveBeenCalled();
    expect(owner.createStores).not.toHaveBeenCalled();
    expect(owner.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "absent", config: undefined },
    { name: "empty", config: {} },
  ])("preserves owner display semantics with $name config", ({ config }) => {
    const render = vi.spyOn(systemPrompt, "buildAgentSystemPrompt");
    const prompt = buildPrompt({
      config,
      ownerNumbers: ["owner-a"],
      ownerDisplay: "hash",
      ownerDisplaySecret: "caller-secret", // pragma: allowlist secret
    });

    expect(render).toHaveBeenCalledTimes(1);
    const renderParams = render.mock.calls[0]?.[0];
    expect(Object.hasOwn(renderParams ?? {}, "ownerDisplay")).toBe(true);
    expect(Object.hasOwn(renderParams ?? {}, "ownerDisplaySecret")).toBe(true);
    expect(renderParams?.ownerDisplay).toBe(config ? "raw" : "hash");
    expect(renderParams?.ownerDisplaySecret).toBe(config ? undefined : "caller-secret");
    expect(prompt).toMatch(
      config
        ? /Allowlisted senders: owner-a\. Allowlisted != owner\./
        : /Allowlisted senders: [a-f0-9]{12}\. Allowlisted != owner\./,
    );
  });

  const prefer = { subagents: { delegationMode: "prefer" as const } };
  const suggest = { subagents: { delegationMode: "suggest" as const } };
  it.each<[string, OpenClawConfig, string | undefined, boolean, string?]>([
    ["canonical main", {}, "agent:main:main", true],
    ["channel session", {}, "agent:main:slack:channel:C01234567", false],
    ["custom main key", { session: { mainKey: "inbox" } }, "agent:main:inbox", true],
    ["global main key", { session: { scope: "global" } }, "global", true],
    ["no session key", {}, undefined, false],
    ["explicit prefer", { agents: { defaults: prefer } }, "agent:main:dashboard:project", true],
    ["explicit suggest", { agents: { defaults: suggest } }, "agent:main:main", false],
    [
      "per-agent override",
      {
        agents: {
          defaults: suggest,
          entries: { coordinator: prefer },
        },
      },
      undefined,
      true,
      "coordinator",
    ],
  ])("%s", (_name, config, sessionKey, expected, agentId) => {
    const prompt = buildPrompt({
      config,
      agentId: agentId ?? "main",
      runtimeInfo: { sessionKey },
      toolNames: ["sessions_spawn", "subagents"],
    });
    expect(prompt.includes("## Delegation")).toBe(expected);
    expect(prompt.includes("- Subagents: `sessions_spawn`")).toBe(!expected);
  });
});
