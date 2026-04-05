import { listBundledChannelPlugins, listBundledChannelSetupPlugins } from "./bundled.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

type CachedBootstrapPlugins = {
  sorted: ChannelPlugin[];
  byId: Map<string, ChannelPlugin>;
};

let cachedBootstrapPlugins: CachedBootstrapPlugins | null = null;

function mergePluginSection<T>(
  runtimeValue: T | undefined,
  setupValue: T | undefined,
): T | undefined {
  if (
    runtimeValue &&
    setupValue &&
    typeof runtimeValue === "object" &&
    typeof setupValue === "object"
  ) {
    return {
      ...(runtimeValue as Record<string, unknown>),
      ...(setupValue as Record<string, unknown>),
    } as T;
  }
  return setupValue ?? runtimeValue;
}

function mergeBootstrapPlugin(
  runtimePlugin: ChannelPlugin,
  setupPlugin: ChannelPlugin,
): ChannelPlugin {
  return {
    ...runtimePlugin,
    ...setupPlugin,
    meta: mergePluginSection(runtimePlugin.meta, setupPlugin.meta),
    capabilities: mergePluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
    commands: mergePluginSection(runtimePlugin.commands, setupPlugin.commands),
    doctor: mergePluginSection(runtimePlugin.doctor, setupPlugin.doctor),
    reload: mergePluginSection(runtimePlugin.reload, setupPlugin.reload),
    config: mergePluginSection(runtimePlugin.config, setupPlugin.config),
    setup: mergePluginSection(runtimePlugin.setup, setupPlugin.setup),
    messaging: mergePluginSection(runtimePlugin.messaging, setupPlugin.messaging),
    actions: mergePluginSection(runtimePlugin.actions, setupPlugin.actions),
    secrets: mergePluginSection(runtimePlugin.secrets, setupPlugin.secrets),
  } as ChannelPlugin;
}

function buildBootstrapPlugins(): CachedBootstrapPlugins {
  const byId = new Map<string, ChannelPlugin>();
  for (const plugin of listBundledChannelPlugins()) {
    byId.set(plugin.id, plugin);
  }
  for (const plugin of listBundledChannelSetupPlugins()) {
    const runtimePlugin = byId.get(plugin.id);
    byId.set(plugin.id, runtimePlugin ? mergeBootstrapPlugin(runtimePlugin, plugin) : plugin);
  }
  const sorted = [...byId.values()].toSorted((left, right) => left.id.localeCompare(right.id));
  return { sorted, byId };
}

function getBootstrapPlugins(): CachedBootstrapPlugins {
  cachedBootstrapPlugins ??= buildBootstrapPlugins();
  return cachedBootstrapPlugins;
}

export function listBootstrapChannelPlugins(): readonly ChannelPlugin[] {
  return getBootstrapPlugins().sorted;
}

export function getBootstrapChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = String(id).trim();
  if (!resolvedId) {
    return undefined;
  }
  return getBootstrapPlugins().byId.get(resolvedId);
}

export function clearBootstrapChannelPluginCache(): void {
  cachedBootstrapPlugins = null;
}
