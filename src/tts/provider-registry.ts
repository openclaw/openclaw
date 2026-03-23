import type { OpenClawConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  buildElevenLabsSpeechProvider,
  buildMicrosoftSpeechProvider,
  buildOpenAISpeechProvider,
} from "../plugin-sdk/speech.js";
import type { SpeechProviderId } from "./provider-types.js";

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
  const registry =
    (active?.speechProviders?.length ?? 0) > 0 || !cfg
      ? active
      : loadOpenClawPlugins({ config: cfg });
  return registry?.speechProviders?.map((entry) => entry.provider) ?? [];
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, SpeechProviderPlugin>;
  aliases: Map<string, SpeechProviderPlugin>;
} {
  const canonical = new Map<string, SpeechProviderPlugin>();
  const aliases = new Map<string, SpeechProviderPlugin>();
  const register = (provider: SpeechProviderPlugin) => {
    const id = normalizeSpeechProviderId(provider.id);
    if (!id) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeSpeechProviderId(alias);
      if (normalizedAlias) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const buildProvider of BUILTIN_SPEECH_PROVIDER_BUILDERS) {
    register(buildProvider());
  }
  for (const provider of resolveSpeechProviderPluginEntries(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
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
  return buildProviderMaps(cfg).aliases.get(normalized);
}
