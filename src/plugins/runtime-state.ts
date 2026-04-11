export const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

export type RuntimeTrackedPluginRecord = {
  id: string;
  status?: string;
  format?: string;
};

export type RuntimeTrackedChannelEntry = {
  plugin: {
    id?: string | null;
    meta?: {
      aliases?: string[];
      markdownCapable?: boolean;
    } | null;
  };
};

export type RuntimeTrackedPluginRegistry = {
  plugins: RuntimeTrackedPluginRecord[];
  httpRoutes?: unknown[];
  channels?: RuntimeTrackedChannelEntry[];
};

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
  const state = getPluginRegistryState();
  return state?.workspaceDir ?? undefined;
}
