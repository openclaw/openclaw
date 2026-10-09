/** Tests channel plugin id resolution from config, manifests, and installed state. */
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

const listPotentialConfiguredChannelIds = vi.hoisted(() => vi.fn());
const listExplicitlyDisabledChannelIdsForConfig = vi.hoisted(() =>
  vi.fn((config: OpenClawConfig) => {
    return Object.entries(config.channels ?? {})
      .filter(([, value]) => {
        return (
          Boolean(value) &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as { enabled?: unknown }).enabled === false
        );
      })
      .map(([channelId]) => channelId.toLowerCase());
  }),
);
const listPotentialConfiguredChannelPresenceSignals = vi.hoisted(() => vi.fn());
const hasMeaningfulChannelConfig = vi.hoisted(() =>
  vi.fn((value: unknown) => {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key !== "enabled")
    );
  }),
);
const loadPluginManifestRegistryCore = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndex = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForPluginRegistry = vi.hoisted(() => vi.fn());
const loadPluginRegistrySnapshot = vi.hoisted(() => vi.fn());
const resolveConfigWidePluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("../channels/config-presence.js", () => ({
  listPotentialConfiguredChannelIds,
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelPresenceSignals,
  hasMeaningfulChannelConfig,
}));

vi.mock("./manifest-registry-installed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry-installed.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForInstalledIndex,
  };
});

vi.mock("./plugin-registry-snapshot.js", () => ({
  loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata: (params: unknown) => ({
    snapshot: loadPluginRegistrySnapshot(params),
    diagnostics: [],
  }),
}));

vi.mock("./plugin-registry-contributions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-registry-contributions.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry,
  };
});

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry,
}));

import {
  listConfiguredAnnounceChannelIdsForConfig,
  listConfiguredChannelIdsForReadOnlyScope,
  listExplicitConfiguredChannelIdsForConfig,
  resolveConfiguredChannelPluginIds,
  resolveConfiguredChannelPresencePolicy,
  createGatewayStartupMetadataPluginIdScope,
  loadGatewayStartupPluginPlanWithMetadata,
  resolveGatewayStartupMetadataPluginIds,
  resolveGatewayStartupPluginPlanFromRegistry,
} from "./channel-plugin-ids.js";

function withManifestLoadPaths(
  plugin: Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    channels: [],
    origin: "bundled",
    providers: [],
    cliBackends: [],
    rootDir: `/tmp/plugins/${plugin.id}`,
    source: `/tmp/plugins/${plugin.id}/index.ts`,
    manifestPath: `/tmp/plugins/${plugin.id}/openclaw.plugin.json`,
    skills: [],
    hooks: [],
    ...plugin,
  };
}

function createManifestRegistryFixture(): PluginManifestRegistry {
  const plugins = [
    { id: "demo-channel", channels: ["demo-channel"] },
    { id: "demo-other-channel", channels: ["demo-other-channel"] },
    {
      id: "browser",
      activation: { onStartup: true, onConfigPaths: ["browser"] },
      enabledByDefault: true,
    },
    {
      id: "demo-provider-plugin",
      providers: ["demo-provider"],
      cliBackends: ["demo-cli"],
    },
    {
      id: "microsoft",
      enabledByDefault: true,
      contracts: { speechProviders: ["microsoft", "edge"] },
    },
    {
      id: "tts-local-cli",
      enabledByDefault: true,
      contracts: { speechProviders: ["tts-local-cli", "cli"] },
    },
    { id: "gradium", origin: "global", contracts: { speechProviders: ["gradium"] } },
    {
      id: "anthropic",
      enabledByDefault: true,
      providers: ["anthropic"],
      modelSupport: { modelPrefixes: ["claude-"] },
      cliBackends: ["claude-cli"],
    },
    {
      id: "openai",
      enabledByDefault: true,
      providers: ["openai", "openai-codex"],
      modelSupport: { modelPrefixes: ["gpt-"] },
      contracts: {
        speechProviders: ["openai"],
        realtimeTranscriptionProviders: ["openai"],
        realtimeVoiceProviders: ["openai"],
        imageGenerationProviders: ["openai"],
        videoGenerationProviders: ["openai"],
        embeddingProviders: ["openai"],
      },
    },
    {
      id: "xai",
      enabledByDefault: true,
      contracts: { realtimeVoiceProviders: ["xai", "grok-voice"] },
    },
    {
      id: "ollama",
      enabledByDefault: true,
      providers: ["ollama"],
      contracts: { embeddingProviders: ["ollama"] },
    },
    {
      id: "llama-cpp",
      origin: "global",
      enabledByDefault: true,
      contracts: { embeddingProviders: ["local"] },
    },
    {
      id: "google",
      enabledByDefault: true,
      providers: ["google", "google-gemini-cli"],
      cliBackends: ["google-gemini-cli"],
      contracts: {
        realtimeVoiceProviders: ["google"],
        imageGenerationProviders: ["google"],
        videoGenerationProviders: ["google"],
        musicGenerationProviders: ["google"],
      },
    },
    { id: "amazon-bedrock", enabledByDefault: true, providers: ["amazon-bedrock"] },
    { id: "brave", origin: "global", contracts: { webSearchProviders: ["brave"] } },
    { id: "codex", providers: ["codex"], activation: { onAgentHarnesses: ["codex"] } },
    {
      id: "activation-only-channel-plugin",
      activation: { onChannels: ["activation-only-channel"] },
    },
    {
      id: "workspace-activation-channel-plugin",
      origin: "workspace",
      activation: { onChannels: ["workspace-activation-channel"] },
    },
    {
      id: "global-activation-channel-plugin",
      origin: "global",
      activation: { onChannels: ["global-activation-channel"] },
    },
    {
      id: "external-env-channel-plugin",
      origin: "config",
      channels: ["external-env-channel"],
      packageChannel: {
        id: "external-env-channel",
        configuredState: {
          env: { allOf: ["EXTERNAL_ENV_CHANNEL_HOST", "EXTERNAL_ENV_CHANNEL_NICK"] },
        },
      },
    },
    { id: "voice-call", activation: { onStartup: true } },
    { id: "memory-core", kind: "memory" },
    { id: "memory-lancedb", kind: "memory" },
    {
      id: "demo-global-explicit-startup",
      origin: "global",
      activation: { onStartup: true },
    },
    {
      id: "source-external-startup",
      enabledByDefault: true,
      activation: { onStartup: true },
      channels: ["source-external-channel"],
      providers: ["source-external-provider"],
      packageManifest: { build: { bundledDist: false } },
    },
    {
      id: "external-config-startup",
      origin: "global",
      activation: {
        onStartup: false,
        onConfigPaths: ["plugins.entries.external-config-startup.config.autoStart"],
      },
    },
    {
      id: "external-hook-capability",
      origin: "global",
      activation: { onCapabilities: ["hook"] },
    },
    { id: "external-hook-policy", origin: "global" },
    {
      id: "external-trusted-policy",
      origin: "global",
      contracts: { trustedToolPolicies: ["workflow-budget"] },
    },
    // Keep the legacy installed-index origin: #76576 must exercise the original
    // context-engine regression even though current manifest origins are narrower.
    {
      id: "lossless-claw",
      kind: "context-engine",
      origin: "installed" as PluginManifestRecord["origin"],
    },
    {
      id: "qa-lab",
      activation: { onStartup: false },
      contracts: { workerProviders: ["static-ssh"] },
    },
    {
      id: "external-worker-provider",
      origin: "global",
      contracts: { workerProviders: ["external-ssh"] },
    },
    {
      id: "storage-fixture",
      activation: { onStartup: false },
      contracts: { storageProviders: ["archive-objects"] },
    },
  ] satisfies Array<Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>>;

  return {
    plugins: plugins.map(withManifestLoadPaths),
    diagnostics: [],
  };
}

function createManifestRegistryFixtureWithWorkspaceDemoChannel(): PluginManifestRegistry {
  const fixture = createManifestRegistryFixture();
  fixture.plugins.push(
    withManifestLoadPaths({
      id: "workspace-demo-channel-plugin",
      channels: ["demo-channel"],
      origin: "workspace",
    }),
  );
  return fixture;
}

function filterManifestRegistryForInstalledIndex(params: {
  pluginIds?: readonly string[];
  includeDisabled?: boolean;
}): PluginManifestRegistry {
  const registry = loadPluginManifestRegistryCore() as PluginManifestRegistry;
  const pluginIdSet = params.pluginIds?.length ? new Set(params.pluginIds) : null;
  return {
    ...registry,
    plugins: pluginIdSet
      ? registry.plugins.filter((plugin) => pluginIdSet.has(plugin.id))
      : registry.plugins,
  };
}

function useManifestRegistryFixture(
  registry: PluginManifestRegistry = createManifestRegistryFixture(),
) {
  const index = createInstalledPluginIndexFixture(registry);
  loadPluginManifestRegistryCore.mockReset().mockReturnValue(registry);
  loadPluginManifestRegistryForPluginRegistry
    .mockReset()
    .mockImplementation(() => loadPluginManifestRegistryCore());
  loadPluginRegistrySnapshot.mockReset().mockReturnValue(index);
  resolveConfigWidePluginManifestRegistry.mockReset().mockReturnValue(registry);
  return { registry, index };
}

function expectStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workerProviderIds?: readonly string[];
  expected: readonly string[];
}) {
  const { expected, ...options } = params;
  const manifestRegistry = loadPluginManifestRegistryCore() as PluginManifestRegistry;
  expect(
    resolveGatewayStartupPluginPlanFromRegistry({
      ...options,
      env: params.env ?? {},
      index: createInstalledPluginIndexFixture(manifestRegistry),
      manifestRegistry,
    }).pluginIds,
  ).toEqual(expected);
}

function resolveStartupMetadataScope(
  config: OpenClawConfig,
  index = createInstalledPluginIndexFixture(loadPluginManifestRegistryCore()),
) {
  return resolveGatewayStartupMetadataPluginIds({ config, env: {}, index });
}

function createStartupConfig(params: {
  enabledPluginIds?: string[];
  modelId?: string;
  channelIds?: string[];
  allowPluginIds?: string[];
  noConfiguredChannels?: boolean;
  memorySlot?: string;
  contextEngine?: string;
}) {
  const slotsConfig = {
    ...(params.memorySlot ? { memory: params.memorySlot } : {}),
    ...(params.contextEngine ? { contextEngine: params.contextEngine } : {}),
  };
  const hasSlots = Object.keys(slotsConfig).length > 0;
  const includeSlots =
    hasSlots && (!params.allowPluginIds?.length || Boolean(params.enabledPluginIds?.length));
  const config: Record<string, unknown> = {};

  if (params.noConfiguredChannels) {
    config.channels = {};
  } else if (params.channelIds?.length) {
    config.channels = Object.fromEntries(
      params.channelIds.map((channelId) => [channelId, { enabled: true }]),
    );
  }

  if (params.enabledPluginIds?.length || params.allowPluginIds?.length || hasSlots) {
    config.plugins = {
      ...(params.allowPluginIds?.length ? { allow: params.allowPluginIds } : {}),
      ...(includeSlots ? { slots: slotsConfig } : {}),
      ...(params.enabledPluginIds?.length
        ? {
            entries: Object.fromEntries(
              params.enabledPluginIds.map((pluginId) => [pluginId, { enabled: true }]),
            ),
          }
        : {}),
    };
  }

  if (params.modelId) {
    config.agents = {
      defaults: {
        model: { primary: params.modelId },
        models: { [params.modelId]: {} },
      },
    };
  }

  return config as OpenClawConfig;
}

describe("resolveGatewayStartupPluginPlanFromRegistry", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.hasOwn(config, "channels")) {
        return Object.keys(config.channels ?? {});
      }
      return ["demo-channel"];
    });
    listPotentialConfiguredChannelPresenceSignals
      .mockReset()
      .mockImplementation((config: OpenClawConfig) => {
        return listPotentialConfiguredChannelIds(config).map((channelId: string) => ({
          channelId,
          source: "env",
        }));
      });
    useManifestRegistryFixture();
    loadPluginManifestRegistryForInstalledIndex
      .mockReset()
      .mockImplementation(filterManifestRegistryForInstalledIndex);
  });

  it.each([
    [
      "includes bundled model providers selected by agent defaults at startup",
      createStartupConfig({
        modelId: "amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      }),
      ["demo-channel", "browser", "amazon-bedrock", "memory-core"],
    ],
    [
      "includes bundled model providers selected only as agent fallbacks at startup",
      {
        agents: {
          defaults: {
            model: { fallbacks: ["amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"] },
          },
        },
      } as OpenClawConfig,
      ["demo-channel", "browser", "amazon-bedrock", "memory-core"],
    ],
    [
      "honors explicit plugin disablement for selected model providers",
      {
        agents: {
          defaults: {
            model: { primary: "amazon-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
          },
        },
        plugins: { entries: { "amazon-bedrock": { enabled: false } } },
      } as OpenClawConfig,
      ["demo-channel", "browser", "memory-core"],
    ],
    [
      "includes Codex when an OpenAI agent model uses the implicit runtime default",
      createStartupConfig({ modelId: "openai/gpt-5.5" }),
      ["demo-channel", "browser", "openai", "codex", "memory-core"],
    ],
    [
      "includes Codex when OpenAI is a selectable default agent model",
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: { "openai/gpt-5.5": {} },
          },
        },
      } as OpenClawConfig,
      ["demo-channel", "browser", "anthropic", "openai", "codex", "memory-core"],
    ],
    [
      "does not include Codex when an OpenAI model is manually pinned to OpenClaw",
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
          },
        },
      } as OpenClawConfig,
      ["demo-channel", "browser", "openai", "memory-core"],
    ],
    [
      "includes required CLI backend owner plugins for provider runtime policy",
      {
        models: {
          providers: {
            "demo-provider": {
              baseUrl: "https://example.com",
              models: [],
              agentRuntime: { id: "demo-cli" },
            },
          },
        },
        plugins: { entries: { "demo-provider-plugin": { enabled: true } } },
      } as OpenClawConfig,
      ["demo-channel", "browser", "demo-provider-plugin", "memory-core"],
    ],
    [
      "includes required CLI backend owner plugins for model runtime policy",
      {
        agents: {
          defaults: {
            models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
          },
        },
      } as OpenClawConfig,
      ["demo-channel", "browser", "anthropic", "memory-core"],
    ],
    [
      "does not include required CLI backend owner plugins when they are explicitly disabled",
      {
        models: {
          providers: {
            "demo-provider": {
              baseUrl: "https://example.com",
              models: [],
              agentRuntime: { id: "demo-cli" },
            },
          },
        },
        plugins: { entries: { "demo-provider-plugin": { enabled: false } } },
      } as OpenClawConfig,
      ["demo-channel", "browser", "memory-core"],
    ],
    [
      "ignores memory embedding fallbacks when primary provider is fts-only",
      {
        channels: {},
        memory: { search: { provider: "none", fallback: "openai" } },
        agents: { defaults: {} },
      } as OpenClawConfig,
      ["browser", "memory-core"],
    ],
    [
      "includes only configured channel plugins at idle startup",
      createStartupConfig({
        enabledPluginIds: ["voice-call"],
        modelId: "demo-cli/demo-model",
      }),
      ["demo-channel", "browser", "voice-call", "memory-core"],
    ],
    [
      "activates the sole Talk speech provider from its capability alias",
      { channels: {}, talk: { providers: { edge: {} } } } as OpenClawConfig,
      ["browser", "microsoft", "memory-core"],
    ],
    [
      "activates the selected Talk realtime capability alias",
      { channels: {}, talk: { realtime: { provider: "grok-voice" } } } as OpenClawConfig,
      ["browser", "xai", "memory-core"],
    ],
    [
      "includes bundled speech providers configured by provider block",
      {
        channels: {},
        tts: { providers: { "tts-local-cli": { command: "say" } } },
      } as OpenClawConfig,
      ["browser", "tts-local-cli", "memory-core"],
    ],
    [
      "maps legacy edge TTS selection to the Microsoft speech plugin",
      {
        channels: {},
        tts: { provider: "edge" },
      } as OpenClawConfig,
      ["browser", "microsoft", "memory-core"],
    ],
    [
      "includes explicitly enabled external speech providers at startup",
      {
        channels: {},
        tts: { provider: "gradium" },
        plugins: { entries: { gradium: { enabled: true } } },
      } as OpenClawConfig,
      ["browser", "gradium", "memory-core"],
    ],
    [
      "includes account-inherited active persona speech providers at startup",
      {
        channels: { "demo-channel": { accounts: { primary: { tts: { persona: "narrator" } } } } },
        tts: {
          personas: {
            narrator: {
              label: "Narrator",
              provider: "microsoft",
            },
          },
        },
      } as OpenClawConfig,
      ["demo-channel", "browser", "microsoft", "memory-core"],
    ],
    [
      "honors disabled speech provider config blocks at startup",
      {
        channels: {},
        tts: {
          provider: "microsoft",
          providers: { microsoft: { enabled: false } },
        },
      } as OpenClawConfig,
      ["browser", "memory-core"],
    ],
    [
      "includes bundled generation providers configured by media defaults at startup",
      {
        channels: {},
        agents: {
          defaults: {
            mediaModels: {
              image: {
                primary: "openai/gpt-image-2",
                fallbacks: ["google/gemini-3-pro-image-preview"],
              },
              video: { primary: "google/veo-3.1-fast-generate-preview" },
              music: { primary: "google/lyria-3-clip-preview" },
            },
          },
        },
      } as OpenClawConfig,
      ["browser", "openai", "google", "memory-core"],
    ],
    [
      "includes bundled voice providers configured by voice defaults at startup",
      {
        channels: {},
        agents: {
          defaults: {
            voiceModel: {
              primary: "openai/gpt-4o-mini-tts",
              fallbacks: ["google/gemini-live-2.5-flash-preview"],
            },
          },
        },
      } as OpenClawConfig,
      ["browser", "openai", "google", "memory-core"],
    ],
    [
      "includes the api-owner plugin for a custom models.providers memory embedding fallback at startup",
      {
        channels: {},
        memory: { search: { provider: "openai", fallback: "ollama-5080" } },

        models: {
          providers: {
            "ollama-5080": {
              api: "ollama",
              baseUrl: "http://gpu-box.local:11435",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      ["browser", "openai", "ollama", "memory-core"],
    ],
    [
      "does not load plugin owners for custom providers backed by core generic embeddings",
      {
        channels: {},
        memory: { search: { provider: "tenant-embeddings" } },

        models: {
          providers: {
            "tenant-embeddings": {
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      ["browser", "memory-core"],
    ],
    [
      "includes the llama.cpp provider for configured local memory embeddings",
      {
        channels: {},
        memory: { search: { provider: "local", fallback: "auto" } },
      } as OpenClawConfig,
      ["browser", "llama-cpp", "memory-core"],
    ],
    [
      "includes the inherited default provider when a per-agent override re-enables memory search",
      {
        channels: {},
        memory: { search: { enabled: false, provider: "openai", fallback: "ollama" } },

        agents: {
          defaults: {},
          entries: { researcher: { memory: { search: { enabled: true } } } },
        },
      } as OpenClawConfig,
      ["browser", "openai", "ollama", "memory-core"],
    ],
    [
      "includes default memory embedding providers for unlisted agents even when listed agents override memory search",
      {
        channels: {},
        memory: { search: { provider: "openai" } },

        agents: {
          defaults: {},
          entries: {
            muted: { memory: { search: { enabled: false } } },
            researcher: { memory: { search: { provider: "ollama" } } },
          },
        },
      } as OpenClawConfig,
      ["browser", "openai", "ollama", "memory-core"],
    ],
    [
      "honors disabled web search when selecting startup providers",
      {
        channels: {},
        tools: { web: { search: { enabled: false, provider: "brave" } } },
        plugins: { allow: ["brave"], entries: { brave: { enabled: true } } },
      },
      [],
    ],
    [
      "includes explicitly enabled external channel plugins without channel config",
      {
        channels: {},
        plugins: { entries: { "external-env-channel-plugin": { enabled: true } } },
      } as OpenClawConfig,
      ["browser", "external-env-channel-plugin", "memory-core"],
    ],
  ] satisfies Array<[string, OpenClawConfig, string[]]>)("%s", (_name, config, expected) => {
    expectStartupPluginIds({ config, expected });
  });

  it("matches explicitly disabled channel ids case-insensitively", () => {
    const registry = createManifestRegistryFixture();
    useManifestRegistryFixture({
      ...registry,
      plugins: registry.plugins.map((plugin) =>
        plugin.id === "external-env-channel-plugin"
          ? Object.assign({}, plugin, { channels: ["External-Env-Channel"] })
          : plugin,
      ),
    });

    expectStartupPluginIds({
      config: {
        channels: { "external-env-channel": { enabled: false } },
        plugins: { entries: { "external-env-channel-plugin": { enabled: true } } },
      } as OpenClawConfig,
      expected: ["browser", "memory-core"],
    });
  });

  it("starts a renamed external channel after its bundled owner is removed", () => {
    const registry = createManifestRegistryFixture();
    registry.plugins.push(
      withManifestLoadPaths({
        id: "openclaw-qqbot",
        channels: ["qqbot"],
        channelConfigs: {
          qqbot: {
            schema: { type: "object" },
            preferOver: ["qqbot"],
          },
        },
        origin: "global",
        enabledByDefault: undefined,
      }),
    );
    const index = createInstalledPluginIndexFixture(registry);
    const sourceConfig = {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      plugins: { entries: { "openclaw-qqbot": { enabled: true } } },
    } as OpenClawConfig;
    const runtimeConfig = applyPluginAutoEnable({
      config: sourceConfig,
      env: {},
      manifestRegistry: registry,
    }).config;

    expect(runtimeConfig.plugins?.entries?.qqbot).toBeUndefined();
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config: runtimeConfig,
        activationSourceConfig: sourceConfig,
        env: {},
        index,
        manifestRegistry: registry,
      }).pluginIds,
    ).toContain("openclaw-qqbot");
  });

  it("keeps an auto-enabled worker provider in a restrictive reload plan", () => {
    const authoredConfig = {
      channels: {},
      cloudWorkers: { profiles: { development: { provider: "static-ssh" } } },
      plugins: { allow: ["browser"] },
    } as OpenClawConfig;
    const effectiveConfig = applyPluginAutoEnable({
      config: authoredConfig,
      env: {},
      manifestRegistry: createManifestRegistryFixture(),
    }).config;

    expectStartupPluginIds({
      config: effectiveConfig,
      activationSourceConfig: authoredConfig,
      expected: ["browser", "qa-lab"],
    });
  });

  it("keeps a configured storage provider in restrictive startup and metadata plans", () => {
    const authoredConfig: OpenClawConfig = {
      channels: {},
      storage: {
        locations: { archive: { provider: "archive-objects", settings: {}, encryption: "none" } },
      },
      plugins: { allow: ["browser"], slots: { memory: "none" } },
    };
    const registry = createManifestRegistryFixture();
    const effectiveConfig = applyPluginAutoEnable({
      config: authoredConfig,
      env: {},
      manifestRegistry: registry,
    }).config;
    expectStartupPluginIds({
      config: effectiveConfig,
      activationSourceConfig: authoredConfig,
      expected: ["browser", "storage-fixture"],
    });
    expect(
      resolveGatewayStartupMetadataPluginIds({
        config: effectiveConfig,
        activationSourceConfig: authoredConfig,
        env: {},
        index: createInstalledPluginIndexFixture(registry),
      }),
    ).toEqual(["browser", "storage-fixture"]);
  });

  it("keeps durable external worker-provider owners behind explicit enablement", () => {
    expectStartupPluginIds({
      config: { channels: {} } as OpenClawConfig,
      workerProviderIds: ["external-ssh"],
      expected: ["browser", "memory-core"],
    });
    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: { entries: { "external-worker-provider": { enabled: true } } },
      } as OpenClawConfig,
      workerProviderIds: ["external-ssh"],
      expected: ["browser", "memory-core", "external-worker-provider"],
    });
  });

  it("keeps durable worker-provider owners behind disable and allowlist gates", () => {
    expectStartupPluginIds({
      config: { channels: {}, plugins: { enabled: false } } as OpenClawConfig,
      workerProviderIds: ["static-ssh"],
      expected: [],
    });
    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: { entries: { "qa-lab": { enabled: false } } },
      } as OpenClawConfig,
      workerProviderIds: ["static-ssh"],
      expected: ["browser", "memory-core"],
    });
    expectStartupPluginIds({
      config: { channels: {}, plugins: { deny: ["qa-lab"] } } as OpenClawConfig,
      workerProviderIds: ["static-ssh"],
      expected: ["browser", "memory-core"],
    });
    expectStartupPluginIds({
      config: { channels: {}, plugins: { allow: ["browser"] } } as OpenClawConfig,
      workerProviderIds: ["static-ssh"],
      expected: ["browser"],
    });
  });

  it("keeps effective-only bundled sidecars behind restrictive allowlists", () => {
    const rawConfig = createStartupConfig({ allowPluginIds: ["browser"] });
    const effectiveConfig = {
      ...rawConfig,
      plugins: {
        allow: ["browser"],
        entries: {
          "voice-call": { enabled: true },
          "memory-core": { enabled: true },
        },
      },
    } as OpenClawConfig;

    expectStartupPluginIds({
      config: effectiveConfig,
      activationSourceConfig: rawConfig,
      expected: ["browser"],
    });
  });

  it("includes auto-enabled external web search providers at startup", () => {
    const rawConfig = {
      channels: {},
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
          },
        },
      },
      plugins: { allow: ["browser"] },
    } as OpenClawConfig;
    const effectiveConfig = {
      ...rawConfig,
      plugins: {
        allow: ["browser", "brave"],
        entries: { brave: { enabled: true } },
      },
    } as OpenClawConfig;

    expectStartupPluginIds({
      config: effectiveConfig,
      activationSourceConfig: rawConfig,
      expected: ["browser", "brave"],
    });
  });

  it("does not let runtime-default plugin entries bypass the authored startup allowlist", () => {
    const activationSourceConfig = {
      channels: {},
      plugins: {
        allow: ["bench-plugin"],
        entries: { browser: { enabled: false } },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...activationSourceConfig,
      plugins: {
        ...activationSourceConfig.plugins,
        entries: {
          ...activationSourceConfig.plugins?.entries,
          "memory-core": { config: { dreaming: { enabled: false } } },
        },
      },
    } as OpenClawConfig;

    expectStartupPluginIds({
      config: runtimeConfig,
      activationSourceConfig,
      expected: [],
    });
  });

  it("loads enabled plugin tool owners before turns can enter the Gateway", () => {
    useManifestRegistryFixture({
      diagnostics: [],
      plugins: [
        withManifestLoadPaths({
          id: "bundled-tool-owner",
          enabledByDefault: true,
          contracts: { tools: ["bundled_tool"] },
        }),
        withManifestLoadPaths({
          id: "external-tool-owner",
          origin: "global",
          contracts: { tools: ["external_tool"] },
        }),
      ],
    });

    expectStartupPluginIds({
      config: createStartupConfig({ noConfiguredChannels: true, memorySlot: "none" }),
      expected: ["bundled-tool-owner"],
    });
    expectStartupPluginIds({
      config: createStartupConfig({
        enabledPluginIds: ["external-tool-owner"],
        allowPluginIds: ["external-tool-owner"],
        noConfiguredChannels: true,
        memorySlot: "none",
      }),
      expected: ["external-tool-owner"],
    });
  });

  it("starts source-discovered external plugins selected through the allowlist", () => {
    expectStartupPluginIds({
      config: createStartupConfig({
        allowPluginIds: ["source-external-startup"],
        noConfiguredChannels: true,
        memorySlot: "none",
      }),
      expected: ["source-external-startup"],
    });
  });

  it("loads startup-lazy external plugins from config only when explicitly enabled", () => {
    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: {
          slots: { memory: "none" },
          entries: {
            "external-config-startup": {
              enabled: true,
              config: { autoStart: { enabled: true } },
            },
          },
        },
      } as OpenClawConfig,
      expected: ["browser", "external-config-startup"],
    });

    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: {
          slots: { memory: "none" },
          entries: { "external-config-startup": { config: { autoStart: { enabled: true } } } },
        },
      } as OpenClawConfig,
      expected: ["browser"],
    });
  });

  it("does not let effective config broaden authored external config-path activation", () => {
    const activationSourceConfig = {
      channels: {},
      plugins: {
        allow: ["browser"],
        slots: { memory: "none" },
        entries: {
          "external-config-startup": {
            enabled: true,
            config: { autoStart: { enabled: true } },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...activationSourceConfig,
      plugins: {
        ...activationSourceConfig.plugins,
        allow: ["browser", "external-config-startup"],
      },
    } as OpenClawConfig;

    expectStartupPluginIds({
      config: runtimeConfig,
      activationSourceConfig,
      expected: ["browser"],
    });
  });

  it("loads explicit hook-capability plugins at startup", () => {
    expectStartupPluginIds({
      config: createStartupConfig({
        enabledPluginIds: ["external-hook-capability"],
        allowPluginIds: ["external-hook-capability"],
        noConfiguredChannels: true,
        memorySlot: "none",
      }),
      expected: ["external-hook-capability"],
    });
  });

  it.each([
    ["conversation access", { allowConversationAccess: true }],
    ["prompt injection", { allowPromptInjection: true }],
  ] as const)("loads hook-policy plugins with only %s enabled", (_name, hooks) => {
    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: {
          slots: { memory: "none" },
          entries: {
            browser: { enabled: false },
            "external-hook-policy": {
              hooks,
            },
          },
        },
      },
      expected: ["external-hook-policy"],
    });
  });

  it("keeps hook-policy plugins behind restrictive allowlists", () => {
    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: {
          allow: ["browser"],
          slots: { memory: "none" },
          entries: {
            browser: { enabled: false },
            "external-hook-policy": { hooks: { allowPromptInjection: true } },
          },
        },
      },
      expected: [],
    });
  });

  it("does not let effective-only hook policy bypass the authored startup allowlist", () => {
    const activationSourceConfig = {
      channels: {},
      plugins: {
        allow: ["browser"],
        slots: { memory: "none" },
        entries: { browser: { enabled: false } },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      channels: {},
      plugins: {
        allow: ["browser", "external-hook-policy"],
        slots: { memory: "none" },
        entries: {
          browser: { enabled: false },
          "external-hook-policy": { hooks: { allowPromptInjection: true } },
        },
      },
    } as OpenClawConfig;

    expectStartupPluginIds({
      config: runtimeConfig,
      activationSourceConfig,
      expected: [],
    });
  });

  it("lets bundled root config activation paths bypass restrictive allowlists", () => {
    expectStartupPluginIds({
      config: {
        browser: { enabled: true },
        channels: {},
        plugins: { allow: ["telegram"] },
      },
      expected: ["browser"],
    });
  });

  it("does not bypass restrictive allowlists for disabled root config activation paths", () => {
    expectStartupPluginIds({
      config: {
        browser: { enabled: false },
        channels: {},
        plugins: { allow: ["telegram"] },
      },
      expected: [],
    });
  });

  it("does not let weak channel presence start untrusted workspace channel owners", () => {
    useManifestRegistryFixture(createManifestRegistryFixtureWithWorkspaceDemoChannel());
    listPotentialConfiguredChannelIds.mockReturnValue(["demo-channel"]);
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    const config = {} as OpenClawConfig;

    expectStartupPluginIds({
      config,
      env: { DEMO_CHANNEL_ANYTHING: "1" },
      expected: ["demo-channel", "browser", "memory-core"],
    });
  });

  it("recomputes shared config facts when a metadata scope resolves again", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "gpt-5.4@work" } },
      channels: {},
      plugins: { allow: ["browser"], slots: { memory: "none" } },
    };
    const index = createInstalledPluginIndexFixture(createManifestRegistryFixture());
    const scope = createGatewayStartupMetadataPluginIdScope({
      config,
      activationSourceConfig: config,
      env: {},
    });

    expect(scope.resolve({ index })).toEqual(["browser", "openai"]);
    config.agents = { defaults: { model: "anthropic/claude-test" } };
    expect(scope.resolve({ index })).toEqual(["anthropic", "browser"]);
    config.plugins = { ...config.plugins, deny: ["anthropic"] };
    expect(scope.resolve({ index })).toEqual(["browser"]);
  });

  it("preserves both config roles and their exclusions in metadata scopes", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-test" } },
      channels: { "demo-other-channel": { token: "configured" } },
      plugins: { allow: ["browser"], deny: ["qa-lab"], slots: { memory: "none" } },
    };
    const activationSourceConfig: OpenClawConfig = {
      channels: { "demo-channel": { token: "configured" } },
      cloudWorkers: { profiles: { development: { provider: "static-ssh" } } },
      plugins: {
        allow: ["demo-channel"],
        entries: { openai: { enabled: false } },
        slots: { memory: "none" },
      },
    };

    expect(
      resolveGatewayStartupMetadataPluginIds({
        config,
        activationSourceConfig,
        env: {},
        index: createInstalledPluginIndexFixture(createManifestRegistryFixture()),
      }),
    ).toEqual(["browser", "demo-channel", "demo-other-channel"]);
  });

  it("keeps config-path activation owners in restrictive startup metadata scopes", () => {
    expect(
      resolveStartupMetadataScope({
        browser: { enabled: true },
        channels: {},
        plugins: {
          allow: ["openai"],
          slots: { memory: "none" },
        },
      } as OpenClawConfig),
    ).toEqual(["browser", "openai"]);
  });

  it("keeps configured memory embedding providers in restrictive startup metadata scopes", () => {
    expect(
      resolveStartupMetadataScope({
        memory: { search: { provider: "openai", fallback: "ollama" } },

        channels: {},
        plugins: {
          allow: ["browser", "memory-core"],
          slots: { memory: "memory-core" },
        },
      } as OpenClawConfig),
    ).toEqual(["browser", "memory-core", "ollama", "openai"]);
  });

  it("does not use unsafe installed-index model support patterns for startup scopes", () => {
    const registry = {
      plugins: [
        ...createManifestRegistryFixture().plugins,
        withManifestLoadPaths({
          id: "unsafe-model-support",
          enabledByDefault: true,
          modelSupport: { modelPatterns: ["^(a+)+$"] },
        }),
      ],
      diagnostics: [],
    };
    const index = createInstalledPluginIndexFixture(registry);

    expect(
      resolveStartupMetadataScope(
        {
          agents: { defaults: { model: "aaaaaaaaaaaaaaaaaaaaaaaa!" } },
          channels: {},
          plugins: {
            allow: ["browser"],
            slots: { memory: "none" },
          },
        } as OpenClawConfig,
        index,
      ),
    ).toBeUndefined();
  });

  it("falls back to unscoped metadata for legacy indexes without config-path activation metadata", () => {
    const index = createInstalledPluginIndexFixture(loadPluginManifestRegistryCore());
    const browser = index.plugins.find((plugin) => plugin.pluginId === "browser");
    if (!browser) {
      throw new Error("Expected browser plugin fixture");
    }
    delete browser.startup.configPaths;
    browser.compat = ["activation-config-path-hint"];

    expect(
      resolveStartupMetadataScope(
        {
          browser: { enabled: true },
          channels: {},
          plugins: { allow: ["openai"] },
        } as OpenClawConfig,
        index,
      ),
    ).toBeUndefined();
  });

  it("does not scope metadata manifests when bundled discovery compat can widen allowlists", () => {
    expect(
      resolveStartupMetadataScope({
        plugins: {
          allow: ["browser"],
          bundledDiscovery: "compat",
        },
      } as OpenClawConfig),
    ).toBeUndefined();
  });

  it("falls back to unscoped metadata when a configured provider cannot be mapped before manifests", () => {
    expect(
      resolveStartupMetadataScope({
        agents: { defaults: { mediaModels: { image: { primary: "unknown-provider/model" } } } },
        plugins: { allow: ["browser"] },
      } as OpenClawConfig),
    ).toBeUndefined();
  });

  it("does not treat persisted auth alone as gateway startup intent", () => {
    listPotentialConfiguredChannelIds.mockImplementation(
      (
        configForTest: OpenClawConfig,
        _env: NodeJS.ProcessEnv,
        options?: { includePersistedAuthState?: boolean },
      ) => (options?.includePersistedAuthState === false ? [] : ["demo-channel"]),
    );
    listPotentialConfiguredChannelPresenceSignals.mockImplementation(
      (
        _configForTest: OpenClawConfig,
        _env: NodeJS.ProcessEnv,
        options?: { includePersistedAuthState?: boolean },
      ) =>
        options?.includePersistedAuthState === false
          ? []
          : [{ channelId: "demo-channel", source: "persisted-auth" }],
    );

    expectStartupPluginIds({
      config: {} as OpenClawConfig,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-with-persisted-demo-channel" },
      expected: ["browser", "memory-core"],
    });
  });

  it("replans activation from the supplied inventory without rediscovering metadata", () => {
    const { index } = useManifestRegistryFixture({
      plugins: [
        withManifestLoadPaths({
          id: "startup-owner",
          enabledByDefault: true,
          activation: { onStartup: true },
        }),
      ],
      diagnostics: [],
    });
    const startupConfig: OpenClawConfig = {
      channels: {},
      plugins: { enabled: false, slots: { memory: "none" } },
    };
    const metadataSnapshot = loadPluginMetadataSnapshot({
      config: startupConfig,
      env: {},
      workspaceDir: "/workspace/startup",
      index,
    });
    loadPluginManifestRegistryForInstalledIndex.mockClear();
    loadPluginRegistrySnapshot.mockClear();

    for (const [config, expected] of [
      [startupConfig, []],
      [{ channels: {}, plugins: { slots: { memory: "none" } } }, ["startup-owner"]],
      [{ channels: {}, plugins: { deny: ["startup-owner"] } }, []],
    ] satisfies Array<[OpenClawConfig, string[]]>) {
      const result = loadGatewayStartupPluginPlanWithMetadata({
        config,
        env: {},
        workspaceDir: "/workspace/current-run",
        metadataSnapshot,
      });
      expect(result.metadataSnapshot).toBe(metadataSnapshot);
      expect(result.plan.pluginIds).toEqual(expected);
    }
    expect(loadPluginRegistrySnapshot).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("keeps explicitly trusted channel owners eligible in the startup plan", () => {
    const registry = createManifestRegistryFixtureWithWorkspaceDemoChannel();
    const index = createInstalledPluginIndexFixture(registry);

    const plan = resolveGatewayStartupPluginPlanFromRegistry({
      config: {
        channels: { "demo-channel": { token: "configured" } },
        plugins: { allow: ["workspace-demo-channel-plugin"] },
      } as OpenClawConfig,
      env: {},
      index,
      manifestRegistry: registry,
    });

    expect(plan.pluginIds).toContain("workspace-demo-channel-plugin");
  });

  it("includes memory-core as a dreaming sidecar for restrictive selected-memory allowlists", () => {
    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: {
          allow: ["browser", "memory-lancedb"],
          slots: { memory: "memory-lancedb" },
          entries: { "memory-lancedb": { enabled: true, config: { dreaming: { enabled: true } } } },
        },
      } as OpenClawConfig,
      expected: ["browser", "memory-core", "memory-lancedb"],
    });
  });

  it("includes memory-core in restrictive dreaming startup metadata scopes", () => {
    expect(
      resolveStartupMetadataScope({
        channels: {},
        plugins: {
          allow: ["browser", "memory-lancedb"],
          slots: { memory: "memory-lancedb" },
          entries: {
            "memory-lancedb": { enabled: true, config: { dreaming: { enabled: true } } },
          },
        },
      } as OpenClawConfig),
    ).toEqual(["browser", "memory-core", "memory-lancedb"]);
  });

  it("does not include denied memory-core as a restrictive dreaming startup sidecar", () => {
    expectStartupPluginIds({
      config: {
        channels: {},
        plugins: {
          allow: ["browser", "memory-lancedb"],
          deny: ["memory-core"],
          slots: { memory: "memory-lancedb" },
          entries: { "memory-lancedb": { enabled: true, config: { dreaming: { enabled: true } } } },
        },
      } as OpenClawConfig,
      expected: ["browser", "memory-lancedb"],
    });
  });

  it("includes the selected context-engine slot plugin in startup scope even without activation.onStartup (#76576)", () => {
    expectStartupPluginIds({
      config: createStartupConfig({
        enabledPluginIds: ["lossless-claw"],
        contextEngine: "lossless-claw",
      }),
      expected: ["demo-channel", "browser", "memory-core", "lossless-claw"],
    });
  });

  it("includes required agent harness owner plugins for model runtime policy", () => {
    expectStartupPluginIds({
      config: {
        agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
        plugins: { entries: { codex: { enabled: true } } },
      } as OpenClawConfig,
      expected: ["demo-channel", "browser", "openai", "codex", "memory-core"],
    });
  });

  it("does not include required agent harness owner plugins when they are explicitly disabled", () => {
    expectStartupPluginIds({
      config: {
        agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
        plugins: { entries: { codex: { enabled: false } } },
      } as OpenClawConfig,
      expected: ["demo-channel", "browser", "openai", "memory-core"],
    });
  });
});

describe("resolveConfiguredChannelPluginIds", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockImplementation((config: OpenClawConfig) => {
      if (Object.hasOwn(config, "channels")) {
        return Object.keys(config.channels ?? {});
      }
      return [];
    });
    listPotentialConfiguredChannelPresenceSignals
      .mockReset()
      .mockImplementation((config: OpenClawConfig) => {
        return listPotentialConfiguredChannelIds(config).map((channelId: string) => ({
          channelId,
          source: "config",
        }));
      });
    useManifestRegistryFixture();
  });

  it.each([
    {
      name: "uses manifest activation channel ownership before falling back to direct channel lists",
      config: createStartupConfig({ channelIds: ["activation-only-channel"] }),
      expected: ["activation-only-channel-plugin"],
    },
    {
      name: "keeps bundled activation owners behind restrictive allowlists",
      config: createStartupConfig({
        channelIds: ["activation-only-channel"],
        allowPluginIds: ["browser"],
      }),
      expected: [],
    },
    {
      name: "keeps explicitly configured bundled channel owners under restrictive allowlists",
      config: {
        channels: { "demo-channel": { token: "configured" } },
        plugins: { allow: ["browser"] },
      } as OpenClawConfig,
      env: {},
      expected: ["demo-channel"],
    },
    {
      name: "blocks bundled activation owners when plugins are globally disabled",
      config: {
        channels: { "activation-only-channel": { enabled: true } },
        plugins: { enabled: false },
      } as OpenClawConfig,
      env: {},
      expected: [],
      skipDiscovery: true,
    },
    {
      name: "avoids discovery when the activation source disables plugins",
      config: {
        channels: { "demo-channel": { token: "configured" } },
        plugins: { enabled: true },
      } as OpenClawConfig,
      activationSourceConfig: {
        channels: { "demo-channel": { token: "configured" } },
        plugins: { enabled: false },
      } as OpenClawConfig,
      env: {},
      expected: [],
      skipDiscovery: true,
    },
    {
      name: "keeps effective disablement with an enabled activation source",
      config: {
        channels: { "demo-channel": { token: "configured" } },
        plugins: { enabled: false },
      } as OpenClawConfig,
      activationSourceConfig: {
        channels: { "demo-channel": { token: "configured" } },
        plugins: { enabled: true },
      } as OpenClawConfig,
      expected: [],
    },
    {
      name: "filters untrusted workspace activation owners from configured-channel runtime planning",
      config: createStartupConfig({ channelIds: ["workspace-activation-channel"] }),
      expected: [],
    },
    {
      name: "keeps explicitly enabled global activation owners eligible for configured-channel runtime planning",
      config: createStartupConfig({
        channelIds: ["global-activation-channel"],
        enabledPluginIds: ["global-activation-channel-plugin"],
      }),
      expected: ["global-activation-channel-plugin"],
    },
    {
      name: "does not treat auto-enabled non-bundled channel owners as explicitly trusted",
      config: createStartupConfig({
        channelIds: ["global-activation-channel"],
        enabledPluginIds: ["global-activation-channel-plugin"],
      }),
      activationSourceConfig: createStartupConfig({ channelIds: ["global-activation-channel"] }),
      expected: [],
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    expected: string[];
    skipDiscovery?: boolean;
  }>)("$name", ({ config, activationSourceConfig, env, expected, skipDiscovery }) => {
    expect(
      resolveConfiguredChannelPluginIds({
        config,
        ...(activationSourceConfig ? { activationSourceConfig } : {}),
        workspaceDir: "/tmp",
        env: env ?? process.env,
      }),
    ).toStrictEqual(expected);
    if (skipDiscovery) {
      expect(listPotentialConfiguredChannelPresenceSignals).not.toHaveBeenCalled();
      expect(loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
    }
  });
});

describe("listConfiguredChannelIdsForReadOnlyScope", () => {
  beforeEach(() => {
    listPotentialConfiguredChannelIds.mockReset().mockReturnValue([]);
    listPotentialConfiguredChannelPresenceSignals.mockReset().mockReturnValue([]);
    hasMeaningfulChannelConfig.mockClear();
    useManifestRegistryFixture();
  });

  it("suppresses env-only presence when ambient triggers are disabled", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      resolveConfiguredChannelPresencePolicy({
        config: {},
        workspaceDir: "/tmp",
        env: { DEMO_FAKE_TEST_TRIGGER: "present" } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
        ambientEnvTriggers: "suppress",
      }),
    ).toStrictEqual([]);
  });

  it("retains mixed explicit-config and env presence under suppression", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      resolveConfiguredChannelPresencePolicy({
        config: { channels: { "demo-channel": { enabled: true } } } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: { DEMO_FAKE_TEST_TRIGGER: "present" } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
        ambientEnvTriggers: "suppress",
      }),
    ).toEqual([
      {
        channelId: "demo-channel",
        sources: ["env", "explicit-config"],
        effective: true,
        pluginIds: ["demo-channel"],
        blockedReasons: [],
      },
    ]);
  });

  it("keeps explicitly enabled bundled ambient channel triggers", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config: { plugins: { entries: { "demo-channel": { enabled: true } } } } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: { DEMO_FAKE_TEST_TRIGGER: "present" } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toEqual(["demo-channel"]);
  });

  it("requires every package manifest allOf env variable", () => {
    const config = { plugins: { allow: ["external-env-channel-plugin"] } } as OpenClawConfig;

    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config,
        workspaceDir: "/tmp",
        env: { EXTERNAL_ENV_CHANNEL_HOST: "irc.example.com" } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toStrictEqual([]);
    expect(
      listConfiguredChannelIdsForReadOnlyScope({
        config,
        workspaceDir: "/tmp",
        env: {
          EXTERNAL_ENV_CHANNEL_HOST: "irc.example.com",
          EXTERNAL_ENV_CHANNEL_NICK: "openclaw",
        } as NodeJS.ProcessEnv,
        includePersistedAuthState: false,
      }),
    ).toContain("external-env-channel");
  });

  it("does not let namespace discovery bypass an incomplete trusted channel contract", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "external-env-channel", source: "env" },
    ]);

    expect(
      resolveConfiguredChannelPresencePolicy({
        config: { plugins: { allow: ["external-env-channel-plugin"] } } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: { EXTERNAL_ENV_CHANNEL_HOST: "irc.example.com" },
        includePersistedAuthState: false,
      }),
    ).toStrictEqual([]);
  });

  it("preserves explicit channel intent when ambient credentials are incomplete", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "external-env-channel", source: "env" },
    ]);

    expect(
      resolveConfiguredChannelPresencePolicy({
        config: {
          channels: { "external-env-channel": { token: "configured" } },
          plugins: { allow: ["external-env-channel-plugin"] },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: { EXTERNAL_ENV_CHANNEL_HOST: "irc.example.com" },
        includePersistedAuthState: false,
      }),
    ).toStrictEqual([
      {
        channelId: "external-env-channel",
        sources: ["explicit-config"],
        effective: true,
        pluginIds: ["external-env-channel-plugin"],
        blockedReasons: [],
      },
    ]);
  });

  it("evaluates the trusted installed Slack owner's credential contract", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "slack", source: "env" },
    ]);
    const slackRoot = fileURLToPath(new URL("../../extensions/slack/", import.meta.url));
    const record = {
      ...withManifestLoadPaths({
        id: "slack",
        origin: "global",
        channels: ["slack"],
        packageChannel: {
          id: "slack",
          configuredState: {
            env: { anyOf: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] },
            specifier: "./configured-state",
            exportName: "hasConfiguredSlackChannelState",
          },
        },
      }),
      rootDir: slackRoot,
    } satisfies PluginManifestRecord;
    const config = { plugins: { allow: ["slack"] } } as OpenClawConfig;

    expect(
      resolveConfiguredChannelPresencePolicy({
        config,
        env: { SLACK_BOT_TOKEN: "xoxb-test" },
        manifestRecords: [record],
        includePersistedAuthState: false,
      }),
    ).toStrictEqual([]);
    expect(
      resolveConfiguredChannelPresencePolicy({
        config,
        env: { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" },
        manifestRecords: [record],
        includePersistedAuthState: false,
      }),
    ).toStrictEqual([
      {
        channelId: "slack",
        sources: ["env", "manifest-env"],
        effective: true,
        pluginIds: ["slack"],
        blockedReasons: [],
      },
    ]);
  });

  it("lists explicit configured channels without ambient env triggers", () => {
    expect(
      listExplicitConfiguredChannelIdsForConfig({
        channels: {
          defaults: { model: "sonnet-4.6" },
          modelByChannel: { "demo-channel": { default: "openai/gpt-5.6-luna" } },
          " ": { token: "dummy" },
          "demo-channel": { token: "test-token" },
          " trimmed-channel ": { token: "test-token" },
          "demo-other-channel": { enabled: false },
        },
      } as OpenClawConfig),
    ).toEqual(["demo-channel", "trimmed-channel"]);
  });

  it("does not let disabled mixed-case channel config announce ambient matches", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
    ]);

    expect(
      listConfiguredAnnounceChannelIdsForConfig({
        config: {
          channels: {
            "Demo-Channel": {
              enabled: false,
              token: "stale-token",
            },
          },
          plugins: { entries: { "demo-channel": { enabled: true } } },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: { DEMO_FAKE_TEST_TRIGGER: "ambient" } as NodeJS.ProcessEnv,
      }),
    ).toStrictEqual([]);
  });

  it("uses effective read-only channel policy for announce channels", () => {
    listPotentialConfiguredChannelPresenceSignals.mockReturnValue([
      { channelId: "demo-channel", source: "env" },
      { channelId: "demo-other-channel", source: "config" },
    ]);

    expect(
      listConfiguredAnnounceChannelIdsForConfig({
        config: {
          channels: { "demo-other-channel": { token: "configured" } },
          plugins: { allow: ["demo-other-channel"] },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: { DEMO_FAKE_TEST_TRIGGER: "ambient" } as NodeJS.ProcessEnv,
      }),
    ).toEqual(["demo-other-channel"]);
  });

  it("announces explicit configured channels without installed owners", () => {
    expect(
      listConfiguredAnnounceChannelIdsForConfig({
        config: { channels: { clickclack: { token: "configured" } } } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
      }),
    ).toStrictEqual(["clickclack"]);
  });

  it.each(["clickclack", "demo-channel"])(
    "does not announce %s when suppressed by plugin policy",
    (channelId) => {
      const policies: NonNullable<OpenClawConfig["plugins"]>[] = [
        { enabled: false },
        { deny: [channelId] },
        { entries: { [channelId]: { enabled: false } } },
      ];
      if (channelId === "clickclack") {
        policies.push({ allow: ["slack"] });
      }
      for (const plugins of policies) {
        expect(
          listConfiguredAnnounceChannelIdsForConfig({
            config: { channels: { [channelId]: { token: "configured" } }, plugins },
            workspaceDir: "/tmp",
            env: {},
          }),
        ).toStrictEqual([]);
      }
    },
  );

  it("keeps announce channels with another effective owner", () => {
    expect(
      listConfiguredAnnounceChannelIdsForConfig({
        config: {
          channels: { shared: { token: "configured" } },
          plugins: {
            entries: {
              "shared-good": { enabled: true },
              "shared-disabled": { enabled: false },
            },
          },
        } as OpenClawConfig,
        workspaceDir: "/tmp",
        env: {},
        manifestRecords: ["shared-good", "shared-disabled"].map((id) =>
          withManifestLoadPaths({ id, channels: ["shared"], origin: "config" }),
        ),
      }),
    ).toStrictEqual(["shared"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
