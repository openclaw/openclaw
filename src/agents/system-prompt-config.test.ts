// System prompt config tests cover config-to-prompt parameter resolution through
// the canonical agent prompt facade.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as ttsSettings from "../tts/tts-settings.js";
import * as preparedModelCatalog from "./prepared-model-catalog.js";
import { prepareConfiguredModelAliases } from "./prepared-model-runtime.configured-completion.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
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
      configuredCatalogEntries: entries,
    },
    ModelRegistry.inMemory(templateAuthStorage),
    configuredRuntimeModels,
  );
  const owner = {
    config,
    observationConfig: config,
    catalogOwner: { agentId, workspaceDir: "/tmp/openclaw" },
    agentId,
    agentDir: `/tmp/openclaw/${agentId}/agent`,
    workspaceDir: "/tmp/openclaw",
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot,
    isCurrent: vi.fn(() => true),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries, routeVariants: entries },
    configuredRuntimeModels,
    configuredModelAliases,
    findConfiguredRuntimeModel: () => {
      throw new Error("Prompt rendering must not select runtime models");
    },
    inlineProviderModels: [],
    createStores: vi.fn<PreparedModelRuntimeSnapshot["createStores"]>(() => {
      throw new Error("Prompt rendering must not create runtime stores");
    }),
    loadFullModelCatalog: vi.fn<NonNullable<PreparedModelRuntimeSnapshot["loadFullModelCatalog"]>>(
      () => {
        throw new Error("Prompt rendering must not discover provider models");
      },
    ),
  } satisfies PreparedModelRuntimeSnapshot;
  return owner;
}

function buildPrompt(config: OpenClawConfig, agentId = "main", sessionKey?: string): string {
  return buildConfiguredAgentSystemPrompt({
    config,
    agentId,
    workspaceDir: "/tmp/openclaw",
    toolNames: ["sessions_spawn", "subagents"],
    runtimeInfo: { sessionKey },
  });
}

describe("buildConfiguredAgentSystemPrompt", () => {
  it.each(["minimal", "none"] as const)(
    "skips full-only preparation in %s mode and refreshes the next full prompt",
    (promptMode) => {
      const hint = vi
        .spyOn(ttsSettings, "buildTtsSystemPromptHint")
        .mockReturnValue("Fixture first voice guidance.");
      const models = { "fixture/model": { alias: "Before" } };
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { defaults: { models } },
      };
      const owner = preparedOwner(config, ["model"]);
      const params = {
        config,
        preparedModelRuntime: owner,
        workspaceDir: "/tmp/openclaw",
        includeMemorySection: false,
      };
      try {
        const full = buildConfiguredAgentSystemPrompt(params);
        expect(full).toContain("- Before: fixture/model");
        expect(full).toContain("Fixture first voice guidance.");
        hint.mockClear();
        owner.isCurrent.mockClear();
        const reduced = buildConfiguredAgentSystemPrompt({ ...params, promptMode });
        expect(hint).not.toHaveBeenCalled();
        expect(owner.isCurrent).not.toHaveBeenCalled();
        expect(reduced).not.toContain("## Model Aliases");
        expect(reduced).not.toContain("## Voice (TTS)");
        expect(buildConfiguredAgentSystemPrompt(params)).toBe(full);

        owner.isCurrent.mockReturnValue(false);
        const nextConfig: OpenClawConfig = {
          ...config,
          agents: { defaults: { models: { "fixture/model": { alias: "After" } } } },
        };
        params.config = nextConfig;
        params.preparedModelRuntime = preparedOwner(nextConfig, ["model"]);
        hint.mockReturnValue("Fixture current voice guidance.");
        hint.mockClear();
        expect(buildConfiguredAgentSystemPrompt({ ...params, promptMode })).toBe(reduced);
        expect(hint).not.toHaveBeenCalled();
        const refreshed = buildConfiguredAgentSystemPrompt(params);
        expect(refreshed).toContain("- After: fixture/model");
        expect(refreshed).not.toContain("- Before: fixture/model");
        expect(refreshed).toContain("Fixture current voice guidance.");
        expect(refreshed).not.toContain("Fixture first voice guidance.");
        expect(owner.createStores).not.toHaveBeenCalled();
        expect(owner.loadFullModelCatalog).not.toHaveBeenCalled();
      } finally {
        hint.mockRestore();
      }
    },
  );

  it("advertises supported aliases without discovering models during repeated renders", () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          model: "fixture/current",
          models: {
            "fixture/unsupported": { alias: "Unavailable" },
            "fixture/current": { alias: "Current" },
          },
        },
      },
    };
    const owner = preparedOwner(config, ["current"]);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    for (let index = 0; index < 3; index++) {
      const prompt = buildConfiguredAgentSystemPrompt({
        config,
        agentId: "main",
        workspaceDir: "/tmp/openclaw",
        preparedModelRuntime: owner,
      });
      expect(prompt).toContain("- Current: fixture/current");
      expect(prompt).not.toContain("Unavailable");
      expect(prompt).not.toContain("fixture/unsupported");
    }
    expect(owner.createStores).not.toHaveBeenCalled();
    expect(owner.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["model", "provider"] as const)(
    "advertises an authored %s alias using its captured manifest",
    (kind) => {
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
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
      });
      const authoredRef = kind === "model" ? "fixture/legacy" : "legacy-fixture/current";
      const provider = kind === "model" ? "fixture" : "legacy-fixture";
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: `${provider}/current`,
            modelPolicy: { allow: ["Friendly"] },
            models: { [authoredRef]: { alias: "Friendly" } },
          },
        },
      };
      const owner = preparedOwner(config, ["current"], "main", metadataSnapshot, provider);
      const prompt = buildConfiguredAgentSystemPrompt({
        config,
        agentId: "main",
        workspaceDir: "/tmp/openclaw",
        preparedModelRuntime: owner,
      });
      expect(prompt).toContain(`- Friendly: ${provider}/current`);
      expect(owner.configuredModelAliases).toEqual([
        { provider, model: "current", alias: "Friendly" },
      ]);
    },
  );

  it("advertises an unlisted custom alias without publishing an invented catalog descriptor", () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { models: { "fixture/unlisted": { alias: "Custom" } } } },
      models: {
        providers: {
          fixture: { api: "openai-completions", baseUrl: "https://custom.invalid/v1", models: [] },
        },
      },
    };
    const owner = preparedOwner(config, []);
    const prompt = buildConfiguredAgentSystemPrompt({
      config,
      workspaceDir: "/tmp/openclaw",
      preparedModelRuntime: owner,
    });
    expect(prompt).toContain("- Custom: fixture/unlisted");
    expect(owner.configuredRuntimeModels).toEqual([]);
    expect(owner.modelCatalog.entries).toEqual([]);
  });

  it.each(["agent-owned", "inherited"] as const)(
    "applies per-agent aliases with %s manual model policy",
    (policyOwner) => {
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          defaults: {
            model: "fixture/current",
            modelPolicy: policyOwner === "inherited" ? { allow: ["Shared"] } : undefined,
            models: {
              "fixture/current": { alias: "Shared" },
              "fixture/other": { alias: "Other" },
            },
          },
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
      };
      const owner = preparedOwner(config, ["current", "other"], "writer");
      const prompt = buildConfiguredAgentSystemPrompt({
        config,
        agentId: "writer",
        workspaceDir: "/tmp/openclaw",
        preparedModelRuntime: owner,
      });
      expect(prompt).toContain("- Writer: fixture/current");
      expect(prompt).not.toContain("- Shared:");
      expect(prompt).not.toContain("- Other:");
      expect(owner.configuredRuntimeModels.map(({ modelId }) => modelId)).toEqual([
        "current",
        "other",
      ]);
    },
  );

  it("stops advertising aliases after the prepared owner becomes stale", () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { models: { "fixture/current": { alias: "Current" } } } },
    };
    const owner = preparedOwner(config, ["current"]);
    const params = {
      config,
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      preparedModelRuntime: owner,
    };
    expect(buildConfiguredAgentSystemPrompt(params)).toContain("- Current: fixture/current");
    owner.isCurrent.mockReturnValue(false);
    expect(buildConfiguredAgentSystemPrompt(params)).not.toContain("## Model Aliases");
    expect(owner.loadFullModelCatalog).not.toHaveBeenCalled();
    const replacementConfig: OpenClawConfig = {
      ...config,
      agents: { defaults: { models: { "fixture/current": { alias: "Replacement" } } } },
    };
    const replacement = preparedOwner(replacementConfig, ["current"]);
    expect(
      buildConfiguredAgentSystemPrompt({
        ...params,
        config: replacementConfig,
        preparedModelRuntime: replacement,
      }),
    ).toContain("- Replacement: fixture/current");
  });

  it("advertises only the selected target when configured models share a bare alias", () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          model: "fixture/current",
          models: {
            "fixture/current": { alias: "Shared" },
            "fixture/other": { alias: "Shared" },
          },
        },
      },
    };
    const prompt = buildConfiguredAgentSystemPrompt({
      config,
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      preparedModelRuntime: preparedOwner(config, ["current", "other"]),
    });
    expect(prompt).toContain("- Shared: fixture/other");
    expect(prompt).not.toContain("- Shared: fixture/current");
  });

  it("renders supplied aliases without looking up an ambient model owner", () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { models: { "fixture/current": { alias: "Current" } } } },
    };
    const owner = preparedOwner(config, ["current"], "writer");
    const lookup = vi
      .spyOn(preparedModelCatalog, "getPreparedModelCatalogOwnerSnapshot")
      .mockReturnValue(owner);
    const params = {
      config,
      agentId: "writer",
      workspaceDir: "/tmp/openclaw",
    };
    expect(buildConfiguredAgentSystemPrompt(params)).not.toContain("## Model Aliases");
    const prompt = buildConfiguredAgentSystemPrompt({ ...params, preparedModelRuntime: owner });
    expect(lookup).not.toHaveBeenCalled();
    expect(prompt).toContain("- Current: fixture/current");
  });

  it.each([
    { name: "absent", config: undefined },
    { name: "empty", config: {} },
    {
      name: "retired hash",
      config: {
        commands: { ownerDisplay: "hash", ownerDisplaySecret: "retired-secret" },
      } as OpenClawConfig,
    },
    {
      name: "retired raw",
      config: {
        commands: { ownerDisplay: "raw", ownerDisplaySecret: "retired-secret" },
      } as OpenClawConfig,
    },
  ])("preserves owner display semantics with $name config", ({ config }) => {
    const render = vi.spyOn(systemPrompt, "buildAgentSystemPrompt");
    try {
      const prompt = buildConfiguredAgentSystemPrompt({
        config,
        workspaceDir: "/tmp/openclaw",
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
    } finally {
      render.mockRestore();
    }
  });

  it.each([
    {
      name: "prefers delegation in the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: true,
    },
    {
      name: "suggests delegation outside the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:slack:channel:C01234567",
      expected: false,
    },
    {
      name: "recognizes a custom canonical main key",
      config: { session: { mainKey: "inbox" } } satisfies OpenClawConfig,
      sessionKey: "agent:main:inbox",
      expected: true,
    },
    {
      name: "recognizes the global-scope canonical main key",
      config: { session: { scope: "global" } } satisfies OpenClawConfig,
      sessionKey: "global",
      expected: true,
    },
    {
      name: "suggests delegation without a render session key",
      config: {} satisfies OpenClawConfig,
      sessionKey: undefined,
      expected: false,
    },
    {
      name: "honors explicit prefer outside the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "prefer" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:dashboard:project",
      expected: true,
    },
    {
      name: "honors explicit suggest in the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "suggest" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: false,
    },
  ])("$name", ({ config, sessionKey, expected }) => {
    const prompt = buildPrompt(config, "main", sessionKey);
    expect(prompt.includes("## Delegation")).toBe(expected);
    expect(prompt.includes("- Subagents: `sessions_spawn`")).toBe(!expected);
  });

  it("lets per-agent sub-agent delegation mode override defaults", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "suggest",
          },
        },
        list: [
          {
            id: "coordinator",
            subagents: {
              delegationMode: "prefer",
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(buildPrompt(config, "coordinator")).toContain("## Delegation");
  });
});
