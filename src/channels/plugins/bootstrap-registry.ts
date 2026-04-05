import { listBundledChannelPluginIds } from "./bundled-ids.js";
import { getBundledChannelPlugin, getBundledChannelSetupPlugin } from "./bundled.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

type CachedBootstrapPlugins = {
  sortedIds: string[];
  byId: Map<string, ChannelPlugin>;
  missingIds: Set<string>;
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
  return {
    sortedIds: listBundledChannelPluginIds(),
    byId: new Map(),
    missingIds: new Set(),
  };
}

function getBootstrapPlugins(): CachedBootstrapPlugins {
  cachedBootstrapPlugins ??= buildBootstrapPlugins();
  return cachedBootstrapPlugins;
}

export function listBootstrapChannelPlugins(): readonly ChannelPlugin[] {
  return getBootstrapPlugins().sortedIds.flatMap((id) => {
    const plugin = getBootstrapChannelPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function getBootstrapChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = String(id).trim();
  if (!resolvedId) {
    return undefined;
  }
  const registry = getBootstrapPlugins();
  const cached = registry.byId.get(resolvedId);
  if (cached) {
    return cached;
  }
  if (registry.missingIds.has(resolvedId)) {
    return undefined;
  }
  const runtimePlugin = getBundledChannelPlugin(resolvedId);
  const setupPlugin = getBundledChannelSetupPlugin(resolvedId);
  const merged =
    runtimePlugin && setupPlugin
      ? mergeBootstrapPlugin(runtimePlugin, setupPlugin)
      : (setupPlugin ?? runtimePlugin);
  if (!merged) {
    registry.missingIds.add(resolvedId);
    return undefined;
  }
  registry.byId.set(resolvedId, merged);
  return merged;
}

export function clearBootstrapChannelPluginCache(): void {
  cachedBootstrapPlugins = null;
}
