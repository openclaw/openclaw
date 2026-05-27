import { getActivePluginRegistry } from "./runtime.js";
import type { CliBackendPlugin } from "./types.js";

export type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
};

export function resolveRuntimeCliBackends(): PluginCliBackendEntry[] {
  return (getActivePluginRegistry()?.cliBackends ?? []).map((entry) => ({
    ...entry.backend,
    pluginId: entry.pluginId,
  }));
}
