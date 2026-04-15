import { normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { MediaUnderstandingProvider } from "../types.js";
import { deepgramProvider } from "./deepgram/index.js";
import { groqProvider } from "./groq/index.js";

const PROVIDERS: MediaUnderstandingProvider[] = [groqProvider, deepgramProvider];

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

export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "gemini") {
    return "google";
  }
  return normalized;
}

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of PROVIDERS) {
    mergeProviderIntoRegistry(registry, provider);
  }
  const active = getActivePluginRegistry();
  // Use the active registry if it exists (even with 0 media providers), so we don't trigger
  // a fresh loadOpenClawPlugins() with a different cacheKey that would wipe the plugin command
  // registry (clearPluginCommands). Only fall back to a snapshot load when there is no active
  // registry at all (e.g., during CLI one-shot invocations outside the gateway).
  const pluginRegistry =
    active ?? loadOpenClawPlugins({ config: cfg, cache: false, activate: false });
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
