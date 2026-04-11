import type { PluginRegistry } from "./registry-types.js";

export const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type GlobalChannelRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    activeRegistry?: PluginRegistry | null;
    channel?: {
      registry: PluginRegistry | null;
    };
  };
};

function countChannels(registry: PluginRegistry | null | undefined): number {
  return registry?.channels?.length ?? 0;
}

export function getActivePluginChannelRegistryFromState(): PluginRegistry | null {
  const state = (globalThis as GlobalChannelRegistryState)[PLUGIN_REGISTRY_STATE];
  const pinnedRegistry = state?.channel?.registry ?? null;
  if (countChannels(pinnedRegistry) > 0) {
    return pinnedRegistry;
  }
  const activeRegistry = state?.activeRegistry ?? null;
  if (countChannels(activeRegistry) > 0) {
    return activeRegistry;
  }
  return pinnedRegistry ?? activeRegistry;
}
