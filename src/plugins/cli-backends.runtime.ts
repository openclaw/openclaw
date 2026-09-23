import type { CliBackendPlugin } from "./cli-backend.types.js";
// Runtime bridge for plugin-provided CLI backends.
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

/** Runtime CLI backend registration with owning plugin id. */
type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
  builtWithOpenClawVersion?: string;
};

type PluginCliBackendMetadata = Pick<
  PluginCliBackendEntry,
  "id" | "modelProvider" | "subscriptionAuthDispatch" | "pluginId"
>;

/** Resolves CLI backends from the active runtime plugin registry. */
export function resolveRuntimeCliBackends(mode: "metadata"): PluginCliBackendMetadata[];
export function resolveRuntimeCliBackends(): PluginCliBackendEntry[];
export function resolveRuntimeCliBackends(mode?: "metadata"): PluginCliBackendMetadata[] {
  const registry = getPluginRegistryForContext();
  return (registry && !isPluginRegistryRetired(registry) ? registry.cliBackends : []).map(
    (entry) =>
      mode === "metadata"
        ? {
            id: entry.backend.id,
            modelProvider: entry.backend.modelProvider,
            subscriptionAuthDispatch: entry.backend.subscriptionAuthDispatch,
            pluginId: entry.pluginId,
          }
        : Object.assign({}, entry.backend, {
            pluginId: entry.pluginId,
            builtWithOpenClawVersion: entry.builtWithOpenClawVersion,
          }),
  );
}
