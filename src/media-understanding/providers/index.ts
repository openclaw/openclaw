import { normalizeProviderId } from "../../agents/model-selection.js";
import { getPluginProvidersByCapability, type PluginProviderEntry } from "../../plugins/runtime.js";
import type { MediaUnderstandingProvider, MediaUnderstandingCapability } from "../types.js";
import { anthropicProvider } from "./anthropic/index.js";
import { deepgramProvider } from "./deepgram/index.js";
import { googleProvider } from "./google/index.js";
import { groqProvider } from "./groq/index.js";
import { minimaxPortalProvider, minimaxProvider } from "./minimax/index.js";
import { mistralProvider } from "./mistral/index.js";
import { moonshotProvider } from "./moonshot/index.js";
import { openaiProvider } from "./openai/index.js";
import { zaiProvider } from "./zai/index.js";

const PROVIDERS: MediaUnderstandingProvider[] = [
  groqProvider,
  openaiProvider,
  googleProvider,
  anthropicProvider,
  minimaxProvider,
  minimaxPortalProvider,
  moonshotProvider,
  mistralProvider,
  zaiProvider,
  deepgramProvider,
];

export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "gemini") {
    return "google";
  }
  return normalized;
}

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

function getPluginMediaProviders(): Record<string, MediaUnderstandingProvider> {
  return getPluginProvidersByCapability(
    (cap): cap is MediaUnderstandingCapability =>
      cap === "audio" || cap === "image" || cap === "video",
    (p: PluginProviderEntry) => {
      if (!p.capabilities) {
        return undefined;
      }
      const capabilities = p.capabilities
        .map(mapMediaCapability)
        .filter((c): c is MediaUnderstandingCapability => c !== undefined);
      const hasMediaCapabilities = capabilities.length > 0;

      if (!hasMediaCapabilities) {
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

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of PROVIDERS) {
    registry.set(normalizeMediaProviderId(provider.id), provider);
  }

  const pluginProviders = getPluginMediaProviders();
  for (const [key, provider] of Object.entries(pluginProviders)) {
    const normalizedKey = normalizeMediaProviderId(key);
    const existing = registry.get(normalizedKey);
    const merged = existing
      ? {
          ...existing,
          // Only override with plugin methods that are actually defined
          ...(provider.capabilities !== undefined && { capabilities: provider.capabilities }),
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
  return registry;
}

// Async variant reserved for future lazy plugin loading
export async function buildMediaUnderstandingRegistryAsync(
  overrides?: Record<string, MediaUnderstandingProvider>,
): Promise<Map<string, MediaUnderstandingProvider>> {
  return buildMediaUnderstandingRegistry(overrides);
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
