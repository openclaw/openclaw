import type { OpenClawConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { SpeechProviderId } from "./provider-types.js";
import { buildElevenLabsSpeechProvider } from "./providers/elevenlabs.js";
import { buildMicrosoftSpeechProvider } from "./providers/microsoft.js";
import { buildOpenAISpeechProvider } from "./providers/openai.js";

const BUILTIN_SPEECH_PROVIDER_BUILDERS = [
  buildOpenAISpeechProvider,
  buildElevenLabsSpeechProvider,
  buildMicrosoftSpeechProvider,
] as const satisfies readonly (() => SpeechProviderPlugin)[];

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

export function normalizeSpeechProviderId(
  providerId: string | undefined,
): SpeechProviderId | undefined {
  const normalized = trimToUndefined(providerId);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

function resolveSpeechProviderPluginEntries(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  const active = getActivePluginRegistry();
  const activeEntries = active?.speechProviders?.map((entry) => entry.provider) ?? [];
  if (activeEntries.length > 0 || !cfg) {
    return activeEntries;
  }
  return loadOpenClawPlugins({ config: cfg }).speechProviders.map((entry) => entry.provider);
}

function registerSpeechProvider(
  maps: {
    canonical: Map<string, SpeechProviderPlugin>;
    aliases: Map<string, SpeechProviderPlugin>;
  },
  provider: SpeechProviderPlugin,
): void {
  const id = normalizeSpeechProviderId(provider.id);
  if (!id) {
    return;
  }
  maps.canonical.set(id, provider);
  maps.aliases.set(id, provider);
  for (const alias of provider.aliases ?? []) {
    const normalizedAlias = normalizeSpeechProviderId(alias);
    if (normalizedAlias) {
      maps.aliases.set(normalizedAlias, provider);
    }
  }
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, SpeechProviderPlugin>;
  aliases: Map<string, SpeechProviderPlugin>;
} {
  const canonical = new Map<string, SpeechProviderPlugin>();
  const aliases = new Map<string, SpeechProviderPlugin>();
  const maps = { canonical, aliases };

  for (const buildProvider of BUILTIN_SPEECH_PROVIDER_BUILDERS) {
    registerSpeechProvider(maps, buildProvider());
  }
  for (const provider of resolveSpeechProviderPluginEntries(cfg)) {
    registerSpeechProvider(maps, provider);
  }

  return maps;
}

export function listSpeechProviders(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getSpeechProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): SpeechProviderPlugin | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }

  const local = buildProviderMaps().aliases.get(normalized);
  if (local || !cfg) {
    return local;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
