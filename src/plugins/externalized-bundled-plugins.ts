export type ExternalizedBundledPluginBridge = {
  /** Plugin id used while the plugin was bundled in core. */
  bundledPluginId: string;
  /** Plugin id declared by the external package. Defaults to bundledPluginId. */
  pluginId?: string;
  /** npm spec OpenClaw should install when migrating the bundled plugin out. */
  npmSpec: string;
  /** Bundled directory name, when it differs from bundledPluginId. */
  bundledDirName?: string;
  /** Legacy ids that should be treated as this plugin during enablement checks. */
  legacyPluginIds?: readonly string[];
  /** Channel ids that imply this plugin is enabled when configured. */
  channelIds?: readonly string[];
  /** Plugin ids this external package supersedes for channel selection. */
  preferOver?: readonly string[];
};

const EXTERNALIZED_BUNDLED_PLUGIN_BRIDGES: readonly ExternalizedBundledPluginBridge[] = [
  {
    bundledPluginId: "tlon",
    npmSpec: "@openclaw/tlon",
    channelIds: ["tlon"],
  },
  {
    bundledPluginId: "twitch",
    npmSpec: "@openclaw/twitch",
    channelIds: ["twitch", "twitch-chat"],
    legacyPluginIds: ["twitch-chat"],
  },
  {
    bundledPluginId: "synology-chat",
    npmSpec: "@openclaw/synology-chat",
    channelIds: ["synology-chat"],
  },
];

function normalizePluginId(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function getExternalizedBundledPluginTargetId(
  bridge: ExternalizedBundledPluginBridge,
): string {
  return normalizePluginId(bridge.pluginId) || normalizePluginId(bridge.bundledPluginId);
}

export function getExternalizedBundledPluginLookupIds(
  bridge: ExternalizedBundledPluginBridge,
): readonly string[] {
  return Array.from(
    new Set(
      [
        bridge.bundledPluginId,
        bridge.pluginId,
        ...(bridge.legacyPluginIds ?? []),
        ...(bridge.channelIds ?? []),
      ]
        .map(normalizePluginId)
        .filter(Boolean),
    ),
  );
}

export function listExternalizedBundledPluginBridges(): readonly ExternalizedBundledPluginBridge[] {
  return EXTERNALIZED_BUNDLED_PLUGIN_BRIDGES;
}
