import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { RealtimeTranscriptionProviderId } from "./provider-types.js";

export function normalizeRealtimeTranscriptionProviderId(
  providerId: string | undefined,
): RealtimeTranscriptionProviderId | undefined {
  return normalizeOptionalString(providerId)?.toLowerCase();
}

function resolveRealtimeTranscriptionProviderEntries(
  cfg?: OpenClawConfig,
): RealtimeTranscriptionProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "realtimeTranscriptionProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, RealtimeTranscriptionProviderPlugin>;
  aliases: Map<string, RealtimeTranscriptionProviderPlugin>;
} {
  const canonical = new Map<string, RealtimeTranscriptionProviderPlugin>();
  const aliases = new Map<string, RealtimeTranscriptionProviderPlugin>();
  const register = (provider: RealtimeTranscriptionProviderPlugin) => {
    const id = normalizeRealtimeTranscriptionProviderId(provider.id);
    if (!id) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeRealtimeTranscriptionProviderId(alias);
      if (normalizedAlias) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of resolveRealtimeTranscriptionProviderEntries(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
}

export function listRealtimeTranscriptionProviders(
  cfg?: OpenClawConfig,
): RealtimeTranscriptionProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getRealtimeTranscriptionProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeTranscriptionProviderPlugin | undefined {
  const normalized = normalizeRealtimeTranscriptionProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}

export function canonicalizeRealtimeTranscriptionProviderId(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeTranscriptionProviderId | undefined {
  const normalized = normalizeRealtimeTranscriptionProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return getRealtimeTranscriptionProvider(normalized, cfg)?.id ?? normalized;
}
