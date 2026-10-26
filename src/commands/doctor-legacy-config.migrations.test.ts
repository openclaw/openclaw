// Load the shared migration mocks before their production consumers.
// oxfmt-ignore
import { mockPluginProviders, useDoctorLegacyConfigFixture } from "./doctor/shared/legacy-config-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import { listAgentEntries } from "../agents/agent-roster.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { validateConfigObject } from "../config/validation.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { maybeRepairCodexRoutes } from "./doctor/shared/codex-route-warnings.js";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./doctor/shared/legacy-config-migrations.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./doctor/shared/legacy-config-migrations.runtime.models.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";
import { createTestModelDefinition } from "./test-runtime-config-helpers.js";

const codexRuntime = { id: "codex" };
const withProviders = (providers: unknown) => ({ models: { providers } });
const withAgents = (agents: unknown) => ({ agents });

function makeModel(
  id: string,
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return createTestModelDefinition(id, { contextWindow: 128_000, maxTokens: 32_000, ...overrides });
}

function normalizeProviders(providers: unknown) {
  return normalizeCompatibilityConfigValues(withProviders(providers));
}

function normalizeDefaults(defaults: unknown, config: Record<string, unknown> = {}) {
  return normalizeCompatibilityConfigValues({ ...config, agents: { defaults } });
}

function normalizeMistralModels(models: ModelDefinitionConfig[]) {
  return normalizeProviders({
    mistral: { baseUrl: "https://api.mistral.ai/v1", api: "openai-completions", models },
  });
}

function codexProvider(models: unknown[]) {
  return { baseUrl: "https://chatgpt.com/backend-api", api: "openai-chatgpt-responses", models };
}

function normalizeNanoBanana(entry: unknown) {
  return normalizeCompatibilityConfigValues({ skills: { entries: { "nano-banana-pro": entry } } })
    .config;
}

function migrateCodexConfig(config: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(config, changes);
  }
  return config;
}

describe("normalizeCompatibilityConfigValues", () => {
  const fixture = useDoctorLegacyConfigFixture();
  const repairModelRefs = (
    config: unknown,
    options: Parameters<typeof repairStaleAgentModelRefs>[1] = {},
  ) =>
    repairStaleAgentModelRefs(config, {
      ...options,
      env: { OPENCLAW_STATE_DIR: fixture.oauthDir },
    });

  it("drops reserved MCP server names without touching sibling servers", () => {
    const raw: unknown = JSON.parse(
      '{"mcp":{"servers":{"__proto__":{"command":"bad"},"docs":{"command":"docs"}}},"nodeHost":{"mcp":{"servers":{"__proto__":{"command":"bad-node"},"local":{"command":"local"}}}}}',
    );

    const normalized = {
      mcp: { servers: { docs: { command: "docs" } } },
      nodeHost: { mcp: { servers: { local: { command: "local" } } } },
    };
    const migrated = normalizeCompatibilityConfigValues(normalized, { sourceRaw: raw });

    expect(migrated.config).toStrictEqual({
      mcp: { servers: { docs: { command: "docs" } } },
      nodeHost: { mcp: { servers: { local: { command: "local" } } } },
    });
    expect(migrated.changes).toStrictEqual([
      'Dropped MCP server "__proto__" from mcp.servers because the name is reserved; re-add it under a different name.',
      'Dropped MCP server "__proto__" from nodeHost.mcp.servers because the name is reserved; re-add it under a different name.',
    ]);

    const secondPass = normalizeCompatibilityConfigValues(migrated.config);
    expect(secondPass.config).toStrictEqual(migrated.config);
    expect(secondPass.changes).toStrictEqual([]);

    const candidateOnly = normalizeCompatibilityConfigValues(raw, { sourceRaw: {} });
    expect(Object.hasOwn(candidateOnly.config.mcp?.servers ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(candidateOnly.config.nodeHost?.mcp?.servers ?? {}, "__proto__")).toBe(
      false,
    );
    expect(candidateOnly.changes).toStrictEqual(migrated.changes);
  });

  it("defers the whole promotion for uncovered keys on an undeclared channel", () => {
    const config = {
      channels: {
        "uninstalled-demo": {
          dmPolicy: "allowlist",
          appToken: "covered-legacy-key",
          customAuth: "keep-at-root",
          accounts: {},
        },
      },
    };

    const res = normalizeCompatibilityConfigValues(config);

    expect(res.config).toEqual(config);
    expect(res.changes).toStrictEqual([]);
  });

  it("promotes the legacy tier when a loaded adapter is undeclared", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "undeclared-demo",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "undeclared-demo", label: "Undeclared Demo" }),
            setup: {
              applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg,
            },
          },
        },
      ]),
    );

    const res = normalizeCompatibilityConfigValues({
      channels: {
        "undeclared-demo": { dmPolicy: "allowlist", appToken: "legacy-app-token", accounts: {} },
      },
    });

    const channel = res.config.channels?.["undeclared-demo"] as
      | { dmPolicy?: string; appToken?: string; accounts?: Record<string, unknown> }
      | undefined;
    expect(channel?.dmPolicy).toBeUndefined();
    expect(channel?.appToken).toBeUndefined();
    expect(channel?.accounts?.default).toEqual({
      dmPolicy: "allowlist",
      appToken: "legacy-app-token",
    });
  });

  it.each([
    {
      entry: { apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" } },
      apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
    },
    {
      entry: { apiKey: "ignored-skill-api-key", env: { GEMINI_API_KEY: "env-gemini-key" } },
      apiKey: "env-gemini-key",
    },
  ])(
    "migrates nano-banana image config with env-over-skill credential precedence: %j",
    ({ entry, apiKey }) => {
      const config = normalizeNanoBanana(entry);
      expect(config.agents?.defaults?.mediaModels?.image).toEqual({
        primary: "google/gemini-3-pro-image-preview",
      });
      expect(config.models?.providers?.google).toEqual({
        apiKey,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [],
      });
      expect(config.skills?.entries).toBeUndefined();
    },
  );

  it("migrates legacy OpenAI provider api values to OpenAI completions", () => {
    const res = normalizeProviders({
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai",
        models: [{ ...makeModel("openai/gpt-4o-mini"), api: "openai" }],
      },
    });

    expect(res.config.models?.providers?.openrouter?.api).toBe("openai-completions");
    expect(res.config.models?.providers?.openrouter?.models?.[0]?.api).toBe("openai-completions");
  });

  it("repairs agent model refs whose configured provider was deleted", () => {
    mockPluginProviders(["plugin-provider"]);
    const result = repairModelRefs({
      ...withProviders({ custom: { baseUrl: "http://localhost:1234", models: [] } }),
      agents: {
        defaults: {
          model: {
            primary: "deleted/default-primary",
            fallbacks: ["custom/kept", "openai/gpt-6-astra", "deleted/default-fallback"],
          },
          models: {
            "custom/kept": { alias: "kept" },
            "deleted/models-add-row": { alias: "stale" },
          },
        },
        entries: {
          main: {
            model: "deleted/agent-primary",
            models: { "plugin-provider/kept": {}, "deleted/agent-models-add-row": {} },
          },
        },
      },
    });

    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-6-astra",
      fallbacks: ["custom/kept"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "custom/kept": { alias: "kept" },
      "openai/gpt-6-astra": {},
    });
    expect(result.config.agents?.entries?.main).toMatchObject({
      models: { "plugin-provider/kept": {}, "openai/gpt-6-astra": {} },
    });
    expect(result.config.agents?.entries?.main?.model).toBeUndefined();
  });

  it.each([
    {
      name: "plugin-owned CLI and agent-local models.json providers",
      catalogAgent: "worker",
      providers: ["anthropic", "my-cli"],
      config: withAgents({
        defaults: { model: "my-cli/model" },
        entries: {
          worker: { model: "agent-local/model" },
          core: { model: "anthropic/claude-sonnet-4-6" },
        },
      }),
    },
    {
      name: "configured installable providers",
      catalogAgent: undefined,
      providers: [],
      config: {
        plugins: { allow: ["mistral"], entries: { mistral: { enabled: true } } },
        agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
      },
    },
  ])("preserves model refs backed by $name", ({ catalogAgent, providers, config }) => {
    if (catalogAgent) {
      fixture.seedProviderCatalog(catalogAgent);
    }
    mockPluginProviders(providers);
    const result = repairModelRefs(structuredClone(config));
    expect(result.changes).toEqual([]);
    expect(result.config.agents).toEqual(config.agents);
  });

  it("uses a retained metadata snapshot for plugin-owned providers", () => {
    const config = { agents: { defaults: { model: "my-cli/model" } } };
    const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "my-cli-plugin", providers: ["my-cli"] }],
    });
    const result = repairModelRefs(config, { pluginMetadataSnapshot });

    expect(result.changes).toEqual([]);
    expect(result.config.agents?.defaults?.model).toBe("my-cli/model");
  });

  it("evaluates and repairs every canonical keyed agent", () => {
    fixture.seedProviderCatalog("main");
    mockPluginProviders();
    const result = repairModelRefs(
      withAgents({
        defaults: { model: "agent-local/model" },
        entries: { main: {}, worker: { model: "deleted/worker" } },
      }),
    );

    expect(result.config.agents?.defaults?.model).toBe("openai/gpt-6-astra");
    expect(result.config.agents?.entries?.worker?.model).toBeUndefined();
  });

  it("uses only explicit providers when models.mode is replace", () => {
    const custom = { baseUrl: "http://localhost:1234", models: [{ id: "kept", name: "Kept" }] };
    const result = repairModelRefs({
      models: { mode: "replace", providers: { custom } },
      ...withAgents({
        defaults: {
          model: { primary: "deleted/main", fallbacks: ["plugin-provider/model", "custom/kept"] },
        },
      }),
    });

    expect(result.config.agents?.defaults?.model).toEqual({ primary: "custom/kept" });
  });

  it("keeps the whole provider-conflicted Codex namespace legacy", () => {
    const defaults = {
      model: { primary: "codex/gpt-5.6-sol", fallbacks: ["codex/gpt-5.3-mini"] },
      models: {
        "codex/gpt-5.6-sol": { alias: "blocked" },
        "codex/gpt-5.3-mini": { alias: "unlisted" },
      },
    };
    const migrated = {
      ...withProviders({
        openai: {
          models: [
            {
              id: "gpt-5.6-sol",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          ],
        },
        codex: codexProvider([{ id: "gpt-5.6-sol" }, { id: "gpt-5.4-mini" }]),
      }),
      agents: { defaults: structuredClone(defaults) },
    };
    migrateCodexConfig(migrated);

    const blockedProviderPlan = collectBlockedLegacyOpenAICodexProviderPlan(migrated);
    const normalized = normalizeCompatibilityConfigValues(migrated, {
      blockedModelIdentities: new Set(blockedProviderPlan.blockedModelIdentities),
    });
    const repaired = maybeRepairCodexRoutes({
      cfg: normalized.config,
      blockedProviderPlan,
    });

    expect(repaired.cfg.models?.providers).toHaveProperty("codex");
    expect(repaired.cfg.agents?.defaults?.model).toEqual(defaults.model);
    expect(repaired.cfg.agents?.defaults?.models).toEqual(defaults.models);
    expect(repaired.warnings).toHaveLength(1);
    expect(repaired.warnings[0]).toContain(
      "Legacy Codex provider routes require manual reconciliation",
    );
    expect(repaired.warnings[0]).toContain(
      "Doctor retained matching legacy refs in config, sessions, and cron",
    );
  });

  it("migrates a 2026.6 wizard-shaped Codex config into gateway-loadable canonical state", () => {
    const raw = {
      ...withProviders({
        codex: codexProvider([makeModel("gpt-5.6-sol")]),
      }),
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.6-sol", fallbacks: ["codex/gpt-5.4-mini"] },
          models: { "codex/gpt-5.6-sol": { alias: "codex" }, "codex/gpt-5.4-mini": {} },
        },
      },
      plugins: { entries: { codex: { enabled: true } } },
    };
    const migrated = migrateCodexConfig(structuredClone(raw));
    const normalized = normalizeCompatibilityConfigValues(migrated);
    const repaired = maybeRepairCodexRoutes({ cfg: normalized.config });

    expect(repaired.cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
    expect(repaired.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.6-sol": { alias: "codex", agentRuntime: codexRuntime },
      "openai/gpt-5.4-mini": { agentRuntime: codexRuntime },
    });
    expect(repaired.cfg.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.4-mini",
    ]);
    expect(repaired.cfg.models?.providers).not.toHaveProperty("codex");
    expect(repaired.cfg.models?.providers?.openai?.models?.[0]).toMatchObject({
      id: "gpt-5.6-sol",
      agentRuntime: codexRuntime,
    });
    expect(JSON.stringify(repaired.cfg)).not.toContain('"codex/');
    expect(validateConfigObject(repaired.cfg).ok).toBe(true);
  });

  it("migrates legacy Claude CLI refs in agent entries", () => {
    const canonicalOpus = { alias: "Canonical Opus", agentRuntime: { id: "openclaw" } };
    const worker = { model: "openai/gpt-5.5" };
    const res = normalizeCompatibilityConfigValues(
      withAgents({
        entries: {
          main: {
            model: {
              primary: "claude-cli/claude-opus-4-7",
              fallbacks: ["claude-cli/claude-sonnet-4-6", "openai/gpt-5.5"],
            },
            models: {
              "claude-cli/claude-opus-4-7": { alias: "Legacy Opus" },
              "anthropic/claude-opus-4-7": structuredClone(canonicalOpus),
              "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
            },
            modelPolicy: {
              allow: ["claude-cli/claude-opus-4-7", "claude-cli/claude-sonnet-4-6"],
            },
          },
          worker: structuredClone(worker),
        },
      }),
    );

    expect(res.config.agents?.entries).toStrictEqual({
      main: {
        model: {
          primary: "anthropic/claude-opus-4-7",
          fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
        },
        models: {
          "anthropic/claude-opus-4-7": canonicalOpus,
          "anthropic/claude-sonnet-4-6": {
            alias: "Sonnet",
            agentRuntime: { id: "claude-cli" },
          },
        },
        modelPolicy: {
          allow: ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6"],
        },
      },
      worker,
    });
  });

  it("preserves runtime policy for allowlist-only legacy refs", () => {
    const res = normalizeDefaults({
      model: { primary: "anthropic/claude-opus-4-7" },
      modelPolicy: { allow: ["claude-cli/claude-sonnet-4-6"] },
    });

    expect(res.config.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
    });
    expect(res.config.agents?.defaults?.modelPolicy).toEqual({
      allow: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("pins migrated Codex CLI refs to Codex when OpenAI uses a custom base URL", () => {
    const res = normalizeDefaults(
      { model: "codex-cli/gpt-5.5" },
      { models: { providers: { openai: { baseUrl: "https://proxy.example/v1" } } } },
    );

    expect(res.config.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(res.config.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual(
      codexRuntime,
    );
  });

  it("migrates existing Codex CLI runtime pins to the Codex app-server runtime", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex-cli", mode: "strict" } } },
        },
        list: [
          {
            id: "reviewer",
            models: { "openai/gpt-5.4-mini": { agentRuntime: { id: "codex-cli" } } },
          },
        ],
      },
      ...withProviders({
        openai: {
          agentRuntime: { id: "codex-cli" },
          models: [{ id: "gpt-5.5", agentRuntime: { id: "codex-cli" } }],
        },
      }),
    });

    expect(res.config.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "codex",
      mode: "strict",
    });
    expect(listAgentEntries(res.config)[0]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual(
      codexRuntime,
    );
    expect(res.config.models?.providers?.openai?.agentRuntime).toEqual(codexRuntime);
    expect(res.config.models?.providers?.openai?.models?.[0]?.agentRuntime).toEqual(codexRuntime);
  });

  it("preserves explicit native config while removing legacy nano-banana skill config", () => {
    const image = { primary: "fal/fal-ai/flux/dev" };
    const google = {
      apiKey: "existing-google-key",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: [],
    };
    const res = normalizeCompatibilityConfigValues({
      agents: { defaults: { mediaModels: { image: structuredClone(image) } } },
      models: { providers: { google } },
      skills: {
        entries: {
          "nano-banana-pro": { apiKey: "legacy-gemini-key" },
          peekaboo: { enabled: true },
        },
      },
    });

    expect(res.config.agents?.defaults?.mediaModels?.image).toEqual(image);
    expect(res.config.models?.providers?.google?.apiKey).toBe("existing-google-key");
    expect(res.config.skills?.entries).toEqual({ peekaboo: { enabled: true } });
  });

  it("removes nano-banana from skills.allowBundled during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: { allowBundled: ["peekaboo", "nano-banana-pro"] },
    });

    expect(res.config.skills?.allowBundled).toEqual(["peekaboo"]);
  });

  it("migrates legacy web search provider config to plugin-owned config paths", () => {
    const res = normalizeCompatibilityConfigValues({
      tools: {
        web: {
          search: {
            provider: "gemini",
            maxResults: 5,
            gemini: { apiKey: "gemini-key", model: "gemini-2.5-flash" },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({ provider: "gemini", maxResults: 5 });
    expect(res.config.plugins?.entries?.google).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "gemini-key", model: "gemini-2.5-flash" } },
    });
  });

  it("normalizes talk provider ids without overriding explicit provider config", () => {
    const res = normalizeCompatibilityConfigValues({
      talk: {
        provider: " elevenlabs ",
        providers: { " elevenlabs ": { voiceId: "voice-123" } },
      },
    });

    expect(res.config.talk).toEqual({
      provider: "elevenlabs",
      providers: { elevenlabs: { voiceId: "voice-123" } },
    });
  });

  it("does not report talk provider normalization for semantically identical key ordering differences", () => {
    const input = {
      talk: {
        interruptOnSpeech: true,
        silenceTimeoutMs: 1500,
        providers: {
          elevenlabs: { apiKey: "secret-key", voiceId: "voice-123", modelId: "eleven_v3" },
        },
        provider: "elevenlabs",
      },
    };

    const res = normalizeCompatibilityConfigValues(input);

    expect(res.config).toEqual(input);
    expect(res.changes).toStrictEqual([]);
  });

  it("normalizes persisted mistral model maxTokens that matched the old context-sized defaults", () => {
    const res = normalizeMistralModels([
      makeModel("mistral-large-latest", { contextWindow: 262144, maxTokens: 262144 }),
      makeModel("magistral-small", { maxTokens: 128000 }),
    ]);

    expect(res.config.models?.providers?.mistral?.models).toMatchObject([
      { id: "mistral-large-latest", maxTokens: 16384, cost: { cacheRead: 0.05 } },
      { id: "magistral-small", maxTokens: 40000, cost: { cacheRead: 0.05 } },
    ]);
  });

  it("normalizes old zero Mistral cacheRead costs while preserving custom costs", () => {
    const res = normalizeMistralModels([
      makeModel("codestral-latest", {
        contextWindow: 256000,
        cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
      }),
      makeModel("mistral-medium-3-5", {
        cost: { input: 1.5, output: 7.5, cacheRead: 0.07, cacheWrite: 0 },
      }),
      makeModel("custom-mistral-model", {
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);

    expect(res.config.models?.providers?.mistral?.models).toMatchObject([
      { id: "codestral-latest", cost: { cacheRead: 0.03 } },
      { id: "mistral-medium-3-5", cost: { cacheRead: 0.07 } },
      { id: "custom-mistral-model", cost: { cacheRead: 0 } },
    ]);
  });
});
