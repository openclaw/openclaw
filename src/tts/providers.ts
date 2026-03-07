import { normalizeProviderId } from "../agents/model-selection.js";
import type { TextToSpeechRequest, TextToSpeechResult } from "../media-understanding/types.js";
import { getPluginProvidersByCapability, type PluginProviderEntry } from "../plugins/runtime.js";

export type TtsProvider = {
  id: string;
  textToSpeech: (req: TextToSpeechRequest) => Promise<TextToSpeechResult>;
};

export type TtsProviderRegistry = Map<string, TtsProvider>;

function mapTtsCapability(cap: string): cap is "tts" {
  return cap === "tts";
}

function getPluginTtsProviders(): Record<string, TtsProvider> {
  return getPluginProvidersByCapability(mapTtsCapability, (p: PluginProviderEntry) => {
    if (!p.textToSpeech) {
      return undefined;
    }
    const normalizedId = normalizeProviderId(p.id);
    return {
      id: normalizedId,
      textToSpeech: p.textToSpeech as TtsProvider["textToSpeech"],
    };
  });
}

export function buildTtsProviderRegistry(
  overrides?: Record<string, TtsProvider>,
): TtsProviderRegistry {
  const registry = new Map<string, TtsProvider>();

  const pluginProviders = getPluginTtsProviders();
  if (pluginProviders) {
    for (const [key, provider] of Object.entries(pluginProviders)) {
      registry.set(normalizeProviderId(key), provider);
    }
  }

  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeProviderId(key);
      const existing = registry.get(normalizedKey);
      const merged = existing ? { ...existing, ...provider } : provider;
      registry.set(normalizedKey, merged);
    }
  }
  return registry;
}

// Async variant reserved for future lazy plugin loading
export async function buildTtsProviderRegistryAsync(
  overrides?: Record<string, TtsProvider>,
): Promise<TtsProviderRegistry> {
  return buildTtsProviderRegistry(overrides);
}

export function getTtsProvider(id: string, registry: TtsProviderRegistry): TtsProvider | undefined {
  return registry.get(normalizeProviderId(id));
}
