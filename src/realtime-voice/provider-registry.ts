import type { MullusiConfig } from "../config/config.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceProviderId } from "./provider-types.js";

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

export function normalizeRealtimeVoiceProviderId(
  providerId: string | undefined,
): RealtimeVoiceProviderId | undefined {
  return trimToUndefined(providerId);
}

function resolveRealtimeVoiceProviderEntries(cfg?: MullusiConfig): RealtimeVoiceProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "realtimeVoiceProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: MullusiConfig): {
  canonical: Map<string, RealtimeVoiceProviderPlugin>;
  aliases: Map<string, RealtimeVoiceProviderPlugin>;
} {
  const canonical = new Map<string, RealtimeVoiceProviderPlugin>();
  const aliases = new Map<string, RealtimeVoiceProviderPlugin>();
  const register = (provider: RealtimeVoiceProviderPlugin) => {
    const id = normalizeRealtimeVoiceProviderId(provider.id);
    if (!id) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeRealtimeVoiceProviderId(alias);
      if (normalizedAlias) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of resolveRealtimeVoiceProviderEntries(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
}

export function listRealtimeVoiceProviders(cfg?: MullusiConfig): RealtimeVoiceProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getRealtimeVoiceProvider(
  providerId: string | undefined,
  cfg?: MullusiConfig,
): RealtimeVoiceProviderPlugin | undefined {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}

export function canonicalizeRealtimeVoiceProviderId(
  providerId: string | undefined,
  cfg?: MullusiConfig,
): RealtimeVoiceProviderId | undefined {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return getRealtimeVoiceProvider(normalized, cfg)?.id ?? normalized;
}
