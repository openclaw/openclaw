import type { CliBackendPlugin } from "./cli-backend.types.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
  builtWithOpenClawVersion?: string;
};

type PluginCliBackendMetadata = Pick<
  PluginCliBackendEntry,
  "id" | "modelProvider" | "subscriptionAuthDispatch" | "pluginId"
>;

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
