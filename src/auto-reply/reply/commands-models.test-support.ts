import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginSetupRegistry } from "../../plugins/setup-registry.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const modelCommands: Record<string, NonNullable<ChannelPlugin["commands"]>> = {
  telegram: {
    buildModelsProviderChannelData: ({ providers }) => ({
      telegram: {
        buttons: providers.map(({ id }) => [{ text: id, callback_data: `models:${id}` }]),
      },
    }),
  },
  menuonly: {
    buildModelsMenuChannelData: ({ providers }) => ({
      menuonly: {
        providerIds: providers.map((provider) => provider.id),
        labels: providers.map((provider) => `${provider.id}:${provider.count}`),
      },
    }),
  },
};

const cliBackends = [
  { pluginId: "anthropic", id: "claude-cli", command: "claude" },
  { pluginId: "google", id: "google-gemini-cli", command: "gemini" },
];

export function createModelsTestRegistry() {
  const registry = createTestRegistry(
    (["discord", "whatsapp", "telegram", "menuonly"] as const).map((id) => ({
      pluginId: id,
      plugin: { ...createChannelTestPluginBase({ id }), commands: modelCommands[id] },
      source: "test",
    })),
  );
  registry.cliBackends = cliBackends.map(({ pluginId, id, command }) => ({
    pluginId,
    backend: { id, modelProvider: pluginId, config: { command } },
    source: "test",
  }));
  return registry;
}

export function setFastModelsCliBackendDeps(): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: createEmptyPluginSetupRegistry,
    resolveRuntimeCliBackends: () =>
      cliBackends.map(({ pluginId, id, command }) => ({
        id,
        pluginId: id,
        modelProvider: pluginId,
        config: { command },
        bundleMcp: false,
      })),
  });
}

export function createModelsTestOwner(
  config: OpenClawConfig,
  entries: ModelCatalogEntry[],
  params: { agentId?: string; agentDir?: string; workspaceDir?: string },
): PreparedModelRuntimeSnapshot {
  const owner: PreparedModelRuntimeSnapshot = {
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
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores() {
      throw new Error("Browsing must not start model execution");
    },
  };
  bindPreparedModelRuntimeAuth(owner, { store: { version: 1, profiles: {} } });
  return owner;
}
