import type { PluginRegistry } from "./registry.js";

export const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

export type RegistrySurfaceState = {
  registry: PluginRegistry | null;
  pinned: boolean;
  version: number;
};

export type RegistryState = {
  activeRegistry: PluginRegistry | null;
  activeVersion: number;
  httpRoute: RegistrySurfaceState;
  channel: RegistrySurfaceState;
  key: string | null;
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
  importedPluginIds: Set<string>;
};

type GlobalRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: RegistryState;
};

export function getPluginRegistryState(): RegistryState | undefined {
  return (globalThis as GlobalRegistryState)[PLUGIN_REGISTRY_STATE];
}

export function getActivePluginChannelRegistryFromState(): PluginRegistry | null {
  const state = getPluginRegistryState();
  return state?.channel.registry ?? state?.activeRegistry ?? null;
}

export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  const state = getPluginRegistryState();
  return state?.workspaceDir ?? undefined;
}
