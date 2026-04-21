import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listConfiguredChannelIdsForReadOnlyScope,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";
import { getBundledChannelSetupPlugin } from "./bundled.js";
import { listChannelPlugins } from "./registry.js";
import type { ChannelPlugin } from "./types.plugin.js";

type ReadOnlyChannelPluginOptions = {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  activationSourceConfig?: OpenClawConfig;
  includePersistedAuthState?: boolean;
  cache?: boolean;
};

function resolveReadOnlyChannelPluginOptions(
  envOrOptions?: NodeJS.ProcessEnv | ReadOnlyChannelPluginOptions,
): ReadOnlyChannelPluginOptions {
  if (!envOrOptions) {
    return {};
  }
  if (
    "env" in envOrOptions ||
    "workspaceDir" in envOrOptions ||
    "activationSourceConfig" in envOrOptions ||
    "includePersistedAuthState" in envOrOptions ||
    "cache" in envOrOptions
  ) {
    return envOrOptions as ReadOnlyChannelPluginOptions;
  }
  return { env: envOrOptions as NodeJS.ProcessEnv };
}

function addChannelPlugins(
  byId: Map<string, ChannelPlugin>,
  plugins: Iterable<ChannelPlugin | undefined>,
  options?: {
    onlyIds?: ReadonlySet<string>;
    allowOverwrite?: boolean;
  },
): void {
  for (const plugin of plugins) {
    if (!plugin) {
      continue;
    }
    if (options?.onlyIds && !options.onlyIds.has(plugin.id)) {
      continue;
    }
    if (options?.allowOverwrite === false && byId.has(plugin.id)) {
      continue;
    }
    byId.set(plugin.id, plugin);
  }
}

function resolveReadOnlyWorkspaceDir(
  cfg: OpenClawConfig,
  options: ReadOnlyChannelPluginOptions,
): string | undefined {
  return options.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function listExternalChannelManifestRecords(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): PluginManifestRecord[] {
  return loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  }).plugins.filter((plugin) => plugin.origin !== "bundled" && plugin.channels.length > 0);
}

function resolveExternalReadOnlyChannelPluginIds(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  channelIds: readonly string[];
  records: readonly PluginManifestRecord[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  if (params.channelIds.length === 0) {
    return [];
  }
  const candidatePluginIds = resolveDiscoverableScopedChannelPluginIds({
    config: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    channelIds: params.channelIds,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  });
  if (candidatePluginIds.length === 0) {
    return [];
  }

  const requestedChannelIds = new Set(params.channelIds);
  const candidatePluginIdSet = new Set(candidatePluginIds);
  return params.records
    .filter(
      (plugin) =>
        candidatePluginIdSet.has(plugin.id) &&
        plugin.channels.some((channelId) => requestedChannelIds.has(channelId)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): ChannelPlugin[];
export function listReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  options?: ReadOnlyChannelPluginOptions,
): ChannelPlugin[];
export function listReadOnlyChannelPluginsForConfig(
  cfg: OpenClawConfig,
  envOrOptions?: NodeJS.ProcessEnv | ReadOnlyChannelPluginOptions,
): ChannelPlugin[] {
  const options = resolveReadOnlyChannelPluginOptions(envOrOptions);
  const env = options.env ?? process.env;
  const workspaceDir = resolveReadOnlyWorkspaceDir(cfg, options);
  const externalManifestRecords = listExternalChannelManifestRecords({
    cfg,
    workspaceDir,
    env,
    cache: options.cache,
  });
  const configuredChannelIds = [
    ...new Set(
      listConfiguredChannelIdsForReadOnlyScope({
        config: cfg,
        workspaceDir,
        env,
        cache: options.cache,
        includePersistedAuthState: options.includePersistedAuthState,
        manifestRecords: externalManifestRecords,
      }),
    ),
  ];
  const byId = new Map<string, ChannelPlugin>();

  addChannelPlugins(byId, listChannelPlugins());

  for (const channelId of configuredChannelIds) {
    if (byId.has(channelId)) {
      continue;
    }
    addChannelPlugins(byId, [getBundledChannelSetupPlugin(channelId)]);
  }

  const missingConfiguredChannelIds = configuredChannelIds.filter(
    (channelId) => !byId.has(channelId),
  );
  const externalPluginIds = resolveExternalReadOnlyChannelPluginIds({
    cfg,
    activationSourceConfig: options.activationSourceConfig ?? cfg,
    channelIds: missingConfiguredChannelIds,
    records: externalManifestRecords,
    workspaceDir,
    env,
    cache: options.cache,
  });
  if (externalPluginIds.length > 0) {
    const registry = loadOpenClawPlugins({
      config: cfg,
      activationSourceConfig: options.activationSourceConfig ?? cfg,
      env,
      workspaceDir,
      cache: false,
      activate: false,
      includeSetupOnlyChannelPlugins: true,
      forceSetupOnlyChannelPlugins: true,
      requireSetupEntryForSetupOnlyChannelPlugins: true,
      onlyPluginIds: externalPluginIds,
    });
    addChannelPlugins(
      byId,
      registry.channelSetups.map((setup) => setup.plugin),
      {
        onlyIds: new Set(missingConfiguredChannelIds),
        allowOverwrite: false,
      },
    );
  }

  return [...byId.values()];
}
