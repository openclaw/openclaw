import { getActiveRuntimePluginRegistry } from "./active-runtime-registry.js";
export function resolveRuntimeCliBackends() {
    return (getActiveRuntimePluginRegistry()?.cliBackends ?? []).map((entry) => Object.assign({}, entry.backend, { pluginId: entry.pluginId }));
}
