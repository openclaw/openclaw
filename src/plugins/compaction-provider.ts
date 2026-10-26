import { getPluginInstance } from "./plugin-instance-scope.js";
import type { CompactionProvider } from "./registry-contribution-types.js";
import { requireActivePluginRegistry } from "./runtime.js";

export type { CompactionProvider } from "./registry-contribution-types.js";

export function getCompactionProvider(id: string): CompactionProvider | undefined {
  const registry = requireActivePluginRegistry();
  const registration = registry.compactionProviders.find((entry) => entry.provider.id === id);
  if (!registration) {
    return undefined;
  }
  const record = registry.plugins.find((entry) => entry.id === registration.ownerPluginId);
  const instance = record && getPluginInstance(record);
  return instance?.wrap(registration.provider) ?? registration.provider;
}
