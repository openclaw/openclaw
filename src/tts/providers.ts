import type { OpenClawConfig } from "../config/config.js";
import type { TextToSpeechRequest, TextToSpeechResult } from "../media-understanding/types.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getPluginProvidersByCapability, type PluginProviderEntry } from "../plugins/runtime.js";
import { normalizeSpeechProviderId } from "./provider-registry.js";

export type TtsProvider = {
  id: string;
  textToSpeech: (req: TextToSpeechRequest) => Promise<TextToSpeechResult>;
};

export type TtsProviderRegistry = Map<string, TtsProvider>;

function mapTtsCapability(cap: string): cap is "tts" {
  return cap === "tts";
}

function normalizeTtsProviderId(id: string): string {
  return normalizeSpeechProviderId(id) ?? id;
}

function getPluginTtsProviders(config?: OpenClawConfig): Record<string, TtsProvider> {
  // Ensure plugins are loaded before querying for TTS providers
  loadOpenClawPlugins({ config });
  return getPluginProvidersByCapability(mapTtsCapability, (p: PluginProviderEntry) => {
    if (!p.textToSpeech) {
      return undefined;
    }
    const normalizedId = normalizeTtsProviderId(p.id);
    return {
      id: normalizedId,
      textToSpeech: p.textToSpeech as TtsProvider["textToSpeech"],
    };
  });
}

export function buildTtsProviderRegistry(
  config: OpenClawConfig,
  overrides?: Record<string, TtsProvider>,
): TtsProviderRegistry {
  const registry = new Map<string, TtsProvider>();

  const pluginProviders = getPluginTtsProviders(config);
  for (const [key, provider] of Object.entries(pluginProviders)) {
    registry.set(normalizeTtsProviderId(key), provider);
  }

  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeTtsProviderId(key);
      const existing = registry.get(normalizedKey);
      const merged = existing ? { ...existing, ...provider } : provider;
      registry.set(normalizedKey, merged);
    }
  }
  return registry;
}

// Async variant reserved for future lazy plugin loading
export async function buildTtsProviderRegistryAsync(
  config: OpenClawConfig,
  overrides?: Record<string, TtsProvider>,
): Promise<TtsProviderRegistry> {
  return buildTtsProviderRegistry(config, overrides);
}

export function getTtsProvider(id: string, registry: TtsProviderRegistry): TtsProvider | undefined {
  return registry.get(normalizeTtsProviderId(id));
}
