import type { OpenClawConfig } from "../config/config.js";
import {
  deepgramMediaUnderstandingProvider,
  groqMediaUnderstandingProvider,
} from "../plugin-sdk/media-understanding.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryVersion,
  getPluginProvidersByCapability,
  type PluginProviderEntry,
} from "../plugins/runtime.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";

const PROVIDERS: MediaUnderstandingProvider[] = [
  groqMediaUnderstandingProvider,
  deepgramMediaUnderstandingProvider,
];

let mediaUnderstandingRegistryCache: Map<string, MediaUnderstandingProvider> | null = null;

export function invalidateMediaUnderstandingProviderCache(): void {
  mediaUnderstandingRegistryCache = null;
}

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

function mapMediaCapability(cap: string): MediaUnderstandingCapability | undefined {
  if (cap === "audio") {
    return "audio";
  }
  if (cap === "image") {
    return "image";
  }
  if (cap === "video") {
    return "video";
  }
  return undefined;
}

function isCapabilityArray(cap: unknown): cap is string[] {
  return Array.isArray(cap);
}

const capabilityMethodMap: Record<MediaUnderstandingCapability, keyof PluginProviderEntry> = {
  audio: "transcribeAudio",
  image: "describeImage",
  video: "describeVideo",
};

function getPluginMediaProviders(cfg?: OpenClawConfig): Record<string, MediaUnderstandingProvider> {
  // Ensure plugins are loaded before querying for media providers
  loadOpenClawPlugins({ config: cfg });
  return getPluginProvidersByCapability(
    (cap): cap is MediaUnderstandingCapability =>
      cap === "audio" || cap === "image" || cap === "video",
    (p: PluginProviderEntry) => {
      if (!p.routingCapabilities) {
        return undefined;
      }
      const caps = p.routingCapabilities;
      const rawCapabilities = (isCapabilityArray(caps) ? caps : [])
        .map(mapMediaCapability)
        .filter((c): c is MediaUnderstandingCapability => c !== undefined);
      const capabilities = rawCapabilities.filter((cap) => {
        const methodName = capabilityMethodMap[cap];
        return methodName in p && p[methodName] !== undefined && p[methodName] !== null;
      });

      if (capabilities.length === 0) {
        return undefined;
      }

      const normalizedId = normalizeMediaProviderId(p.id);
      return {
        id: normalizedId,
        capabilities,
        transcribeAudio: p.transcribeAudio as MediaUnderstandingProvider["transcribeAudio"],
        describeImage: p.describeImage as MediaUnderstandingProvider["describeImage"],
        describeVideo: p.describeVideo as MediaUnderstandingProvider["describeVideo"],
      };
    },
  );
}

let cachedRegistryVersion: number | null = null;

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): Map<string, MediaUnderstandingProvider> {
  const currentVersion = getActivePluginRegistryVersion();
  if (!overrides && mediaUnderstandingRegistryCache && cachedRegistryVersion === currentVersion) {
    return mediaUnderstandingRegistryCache;
  }

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

  const pluginProviders = getPluginMediaProviders(cfg);
  for (const [key, provider] of Object.entries(pluginProviders)) {
    const normalizedKey = normalizeMediaProviderId(key);
    const existing = registry.get(normalizedKey);
    const merged = existing
      ? {
          ...existing,
          // Union capabilities from both plugin and built-in (keep all)
          capabilities: [...(existing.capabilities ?? []), ...(provider.capabilities ?? [])],
          // Only override with plugin methods that are actually defined
          ...(provider.transcribeAudio !== undefined && {
            transcribeAudio: provider.transcribeAudio,
          }),
          ...(provider.describeImage !== undefined && { describeImage: provider.describeImage }),
          ...(provider.describeVideo !== undefined && { describeVideo: provider.describeVideo }),
        }
      : provider;
    registry.set(normalizedKey, merged);
  }

  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeMediaProviderId(key);
      const existing = registry.get(normalizedKey);
      // For overrides, replace capabilities (not union) to allow narrowing/disabling
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

  if (!overrides) {
    cachedRegistryVersion = getActivePluginRegistryVersion();
    mediaUnderstandingRegistryCache = registry;
  }
  return registry;
}

// Async variant reserved for future lazy plugin loading
export async function buildMediaUnderstandingRegistryAsync(
  cfg: OpenClawConfig,
  overrides?: Record<string, MediaUnderstandingProvider>,
): Promise<Map<string, MediaUnderstandingProvider>> {
  return buildMediaUnderstandingRegistry(overrides, cfg);
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
