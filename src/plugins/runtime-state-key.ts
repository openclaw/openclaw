export const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type GlobalPluginRegistryWorkspaceState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    workspaceDir?: string | null;
  };
};

export function getActivePluginRegistryWorkspaceDirFromGlobalState(): string | undefined {
  const state = (globalThis as GlobalPluginRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE];
  return state?.workspaceDir ?? undefined;
}
