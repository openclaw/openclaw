import type { OpenClawConfig } from "../config/config.js";
import {
  deepgramMediaUnderstandingProvider,
  groqMediaUnderstandingProvider,
} from "../plugin-sdk/media-understanding.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingProvider } from "./types.js";

const PROVIDERS: MediaUnderstandingProvider[] = [
  groqMediaUnderstandingProvider,
  deepgramMediaUnderstandingProvider,
];

function mergeProviderIntoRegistry(
  registry: Map<string, MediaUnderstandingProvider>,
  provider: MediaUnderstandingProvider,
) {
  const normalizedKey = normalizeMediaProviderId(provider.id);
  const existing = registry.get(normalizedKey);
  const merged = existing
    ? {
        ...existing,
        ...provider,
        capabilities: provider.capabilities ?? existing.capabilities,
      }
    : provider;
  registry.set(normalizedKey, merged);
}

export { normalizeMediaProviderId } from "./provider-id.js";

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of PROVIDERS) {
    mergeProviderIntoRegistry(registry, provider);
  }
  const active = getActivePluginRegistry();
  const pluginRegistry =
    (active?.mediaUnderstandingProviders?.length ?? 0) > 0
      ? active
      : loadOpenClawPlugins({ config: cfg });
  for (const entry of pluginRegistry?.mediaUnderstandingProviders ?? []) {
    mergeProviderIntoRegistry(registry, entry.provider);
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeMediaProviderId(key);
      const existing = registry.get(normalizedKey);
      const merged = existing
        ? {
            ...existing,
            ...provider,
            capabilities: provider.capabilities ?? existing.capabilities,
          }
        : provider;
      registry.set(normalizedKey, merged);
    }
  }
  return registry;
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
