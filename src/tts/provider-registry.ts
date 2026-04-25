import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { SpeechProviderId } from "./provider-types.js";
import { buildAzureSpeechProvider } from "./providers/azure.js";
import { buildElevenLabsSpeechProvider } from "./providers/elevenlabs.js";
import { buildMicrosoftSpeechProvider } from "./providers/microsoft.js";
import { buildOpenAISpeechProvider } from "./providers/openai.js";

const BUILTIN_SPEECH_PROVIDER_BUILDERS = [
  buildOpenAISpeechProvider,
  buildElevenLabsSpeechProvider,
  buildMicrosoftSpeechProvider,
  buildAzureSpeechProvider,
] as const satisfies readonly (() => SpeechProviderPlugin)[];

/**
 * Get all registered speech providers including built-ins.
 */
function getAllSpeechProviders(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  const pluginProviders = resolvePluginCapabilityProviders({
    key: "speechProviders",
    cfg,
  });
  // Also include built-in providers that aren't provided by plugins
  const builtinIds = new Set(BUILTIN_SPEECH_PROVIDER_BUILDERS.map((b) => b().id));
  const pluginIds = new Set(pluginProviders.map((p) => p.id));
  const missingBuiltins = BUILTIN_SPEECH_PROVIDER_BUILDERS
    .filter((b) => !pluginIds.has(b().id))
    .map((b) => b());
  return [...pluginProviders, ...missingBuiltins];
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

export function normalizeSpeechProviderId(
  providerId: string | undefined,
): SpeechProviderId | undefined {
  return trimToUndefined(providerId);
}

function resolveSpeechProviderPluginEntries(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "speechProviders",
    cfg,
  });
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

  for (const provider of getAllSpeechProviders(cfg)) {
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

export function canonicalizeSpeechProviderId(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): SpeechProviderId | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return getSpeechProvider(normalized, cfg)?.id ?? normalized;
}
