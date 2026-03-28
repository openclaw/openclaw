import { GENERATED_BUNDLED_CHANNEL_ENTRIES } from "../../generated/bundled-channel-entries.generated.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

type GeneratedBundledChannelEntry = {
  id: string;
  entry: {
    channelPlugin: ChannelPlugin;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
  };
  setupEntry?: {
    plugin: ChannelPlugin;
  };
};

function isGeneratedBundledChannelEntry(value: unknown): value is GeneratedBundledChannelEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as {
    id?: unknown;
    entry?: {
      channelPlugin?: { id?: unknown };
      setChannelRuntime?: unknown;
    };
    setupEntry?: { plugin?: { id?: unknown } };
  };
  return typeof record.id === "string" && typeof record.entry?.channelPlugin?.id === "string";
}

const generatedBundledChannelEntries = (
  Array.isArray(GENERATED_BUNDLED_CHANNEL_ENTRIES)
    ? GENERATED_BUNDLED_CHANNEL_ENTRIES.filter(isGeneratedBundledChannelEntry)
    : []
) as readonly GeneratedBundledChannelEntry[];

export const bundledChannelPlugins = generatedBundledChannelEntries.map(
  ({ entry }) => entry.channelPlugin,
);

export const bundledChannelSetupPlugins = generatedBundledChannelEntries.flatMap(
  ({ setupEntry }) => {
    const plugin = setupEntry?.plugin;
    return plugin ? [plugin] : [];
  },
);

function buildBundledChannelPluginsById(plugins: readonly ChannelPlugin[]) {
  const byId = new Map<ChannelId, ChannelPlugin>();
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) {
      throw new Error(`duplicate bundled channel plugin id: ${plugin.id}`);
    }
    byId.set(plugin.id, plugin);
  }
  return byId;
}

const bundledChannelPluginsById = buildBundledChannelPluginsById(bundledChannelPlugins);

const bundledChannelRuntimeSettersById = new Map<
  ChannelId,
  NonNullable<GeneratedBundledChannelEntry["entry"]["setChannelRuntime"]>
>();
for (const { entry } of generatedBundledChannelEntries) {
  if (entry.setChannelRuntime) {
    bundledChannelRuntimeSettersById.set(entry.channelPlugin.id, entry.setChannelRuntime);
  }
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return bundledChannelPluginsById.get(id);
}

export function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin {
  const plugin = getBundledChannelPlugin(id);
  if (!plugin) {
    throw new Error(`missing bundled channel plugin: ${id}`);
  }
  return plugin;
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const setter = bundledChannelRuntimeSettersById.get(id);
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
