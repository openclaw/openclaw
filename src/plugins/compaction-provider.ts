import { getPluginValueInstance } from "./plugin-instance-scope.js";
import type { CompactionProvider } from "./registry-contribution-types.js";
import { requireActivePluginRegistry } from "./runtime.js";

export type { CompactionProvider } from "./registry-contribution-types.js";

export function getCompactionProvider(id: string): CompactionProvider | undefined {
  const provider = requireActivePluginRegistry().compactionProviders.find(
    (entry) => entry.provider.id === id,
  )?.provider;
  return provider ? (getPluginValueInstance(provider)?.wrap(provider) ?? provider) : undefined;
}
