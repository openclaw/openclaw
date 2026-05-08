import type { PluginRegistry } from "./registry-types.js";
import {
  getActivePluginRegistryWorkspaceDirFromState as getWorkspaceDirFromState,
  PLUGIN_REGISTRY_STATE,
} from "./runtime-state-key.js";

export { PLUGIN_REGISTRY_STATE };

export type RuntimeTrackedPluginRegistry = PluginRegistry;

export type RegistrySurfaceState = {
  registry: RuntimeTrackedPluginRegistry | null;
  pinned: boolean;
  version: number;
};

export type RegistryState = {
  activeRegistry: RuntimeTrackedPluginRegistry | null;
  activeVersion: number;
  httpRoute: RegistrySurfaceState;
  channel: RegistrySurfaceState;
  key: string | null;
  workspaceDir: string | null;
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
  importedPluginIds: Set<string>;
};

type GlobalRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: RegistryState;
};

export function getPluginRegistryState(): RegistryState | undefined {
  return (globalThis as GlobalRegistryState)[PLUGIN_REGISTRY_STATE];
}

export function getActivePluginChannelRegistryFromState(): RuntimeTrackedPluginRegistry | null {
  const state = getPluginRegistryState();
  return state?.channel.registry ?? state?.activeRegistry ?? null;
}

export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  return getWorkspaceDirFromState();
}
