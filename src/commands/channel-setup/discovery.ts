import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { listChannelPluginCatalogEntries } from "../../channels/plugins/catalog.js";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";

function resolveKnownPluginIds(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  installedPlugins: ChannelSetupPlugin[];
}): Set<string> {
  const ids = new Set<string>();
  for (const plugin of params.installedPlugins) {
    ids.add(String(plugin.id));
  }
  const manifest = loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  for (const plugin of manifest.plugins) {
    ids.add(plugin.id);
    for (const channel of plugin.channels ?? []) {
      ids.add(channel);
    }
  }
  return ids;
}

export function isCatalogChannelInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  workspaceDir?: string;
}): boolean {
  const knownIds = resolveKnownPluginIds({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    installedPlugins: [],
  });
  return (
    knownIds.has(params.entry.id) ||
    Boolean(params.entry.pluginId && knownIds.has(params.entry.pluginId))
  );
}

export function resolveChannelSetupEntries(params: {
  cfg: OpenClawConfig;
  installedPlugins?: ChannelSetupPlugin[];
  workspaceDir?: string;
}): {
  entries: Array<{ id: string; meta: ChannelPluginCatalogEntry["meta"] }>;
  installedCatalogEntries: ChannelPluginCatalogEntry[];
  installableCatalogEntries: ChannelPluginCatalogEntry[];
  installedCatalogById: Map<string, ChannelPluginCatalogEntry>;
  installableCatalogById: Map<string, ChannelPluginCatalogEntry>;
} {
  const installedPlugins = params.installedPlugins ?? [];
  const catalogEntries = listChannelPluginCatalogEntries({ workspaceDir: params.workspaceDir });
  const knownIds = resolveKnownPluginIds({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    installedPlugins,
  });

  const installedCatalogEntries: ChannelPluginCatalogEntry[] = [];
  const installableCatalogEntries: ChannelPluginCatalogEntry[] = [];
  for (const entry of catalogEntries) {
    if (knownIds.has(entry.id) || Boolean(entry.pluginId && knownIds.has(entry.pluginId))) {
      installedCatalogEntries.push(entry);
    } else {
      installableCatalogEntries.push(entry);
    }
  }

  const metaById = new Map<string, ChannelPluginCatalogEntry["meta"]>();
  for (const plugin of installedPlugins) {
    metaById.set(String(plugin.id), plugin.meta);
  }
  for (const entry of installedCatalogEntries) {
    if (!metaById.has(entry.id)) {
      metaById.set(entry.id, entry.meta);
    }
  }
  for (const entry of installableCatalogEntries) {
    if (!metaById.has(entry.id)) {
      metaById.set(entry.id, entry.meta);
    }
  }

  return {
    entries: Array.from(metaById, ([id, meta]) => ({ id, meta })),
    installedCatalogEntries,
    installableCatalogEntries,
    installedCatalogById: new Map(installedCatalogEntries.map((entry) => [entry.id, entry])),
    installableCatalogById: new Map(installableCatalogEntries.map((entry) => [entry.id, entry])),
  };
}
