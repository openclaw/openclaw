export const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
export function getPluginRegistryState() {
    return globalThis[PLUGIN_REGISTRY_STATE];
}
export function getActivePluginChannelRegistryFromState() {
    const state = getPluginRegistryState();
    return state?.channel.registry ?? state?.activeRegistry ?? null;
}
export function getActivePluginRegistryWorkspaceDirFromState() {
    const state = getPluginRegistryState();
    return state?.workspaceDir ?? undefined;
}
