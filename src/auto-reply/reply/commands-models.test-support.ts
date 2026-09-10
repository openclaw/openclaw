import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const telegramModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
  }),
  commands: {
    buildModelsProviderChannelData: ({ providers }) => ({
      telegram: {
        buttons: providers.map((provider) => [
          {
            text: provider.id,
            callback_data: `models:${provider.id}`,
          },
        ]),
      },
    }),
  },
};

const menuOnlyModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "menuonly",
    label: "Menu Only",
    capabilities: {
      chatTypes: ["direct"],
      nativeCommands: true,
    },
  }),
  commands: {
    buildModelsMenuChannelData: ({ providers }) => ({
      menuonly: {
        providerIds: providers.map((provider) => provider.id),
        labels: providers.map((provider) => `${provider.id}:${provider.count}`),
      },
    }),
  },
};

const textSurfaceModelsTestPlugins = (["discord", "whatsapp"] as const).map((id) => ({
  pluginId: id,
  plugin: createChannelTestPluginBase({ id }),
  source: "test",
}));

export function createModelsTestRegistry() {
  const registry = createTestRegistry([
    ...textSurfaceModelsTestPlugins,
    {
      pluginId: "telegram",
      plugin: telegramModelsTestPlugin,
      source: "test",
    },
    {
      pluginId: "menuonly",
      plugin: menuOnlyModelsTestPlugin,
      source: "test",
    },
  ]);
  registry.cliBackends = [
    {
      pluginId: "anthropic",
      backend: {
        id: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
      },
      source: "test",
    },
    {
      pluginId: "google",
      backend: {
        id: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
      },
      source: "test",
    },
  ];
  return registry;
}

export function setFastModelsCliBackendDeps(): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
      {
        id: "google-gemini-cli",
        pluginId: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
        bundleMcp: false,
      },
    ],
  });
}

export function createModelsTestOwner(
  config: OpenClawConfig,
  entries: ModelCatalogEntry[],
  params: { agentId?: string; agentDir?: string; workspaceDir?: string },
): PreparedModelRuntimeSnapshot {
  return {
    catalogOwner: {
      agentId: params.agentId ?? "main",
      workspaceDir: params.workspaceDir ?? "/tmp",
    },
    agentId: params.agentId ?? "main",
    agentDir: params.agentDir ?? "/tmp/models-agent",
    workspaceDir: params.workspaceDir ?? "/tmp",
    activeProjectKeys: [],
    config,
    observationConfig: config,
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent: () => true,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries, routeVariants: entries },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      throw new Error("Browsing must not start model execution");
    },
  };
}
