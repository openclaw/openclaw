import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviderAsync,
  resolvePluginCapabilityProviders,
  resolvePluginCapabilityProvidersAsync,
} from "../plugins/capability-provider-runtime.js";
import { createLegacyPluginSdkProviderProjection } from "../plugins/legacy-sdk-provider-projection.js";
import {
  buildCapabilityProviderIndex,
  normalizeCapabilityProviderId as normalizeRealtimeVoiceProviderId,
} from "../plugins/provider-registry-shared.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceProviderId } from "./provider-types.js";

/**
 * Lists canonical realtime voice providers, discovering additional candidates through manifest policy.
 */
export function listRealtimeVoiceProviders(
  cfg?: OpenClawConfig,
  additionalProviderIds?: readonly string[],
): RealtimeVoiceProviderPlugin[] {
  const providers = resolvePluginCapabilityProviders({
    key: "realtimeVoiceProviders",
    cfg,
    additionalProviderIds,
  });
  return [...buildCapabilityProviderIndex(providers, "canonical").values()];
}

export async function listRealtimeVoiceProvidersAsync(
  cfg?: OpenClawConfig,
  additionalProviderIds?: readonly string[],
): Promise<RealtimeVoiceProviderPlugin[]> {
  using projection = createLegacyPluginSdkProviderProjection();
  const providers = await resolvePluginCapabilityProvidersAsync(
    { key: "realtimeVoiceProviders", cfg, additionalProviderIds },
    (registry) => projection.select(registry),
  );
  projection.adopt();
  return [...buildCapabilityProviderIndex(providers, "canonical").values()];
}

export function getRealtimeVoiceProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeVoiceProviderPlugin | undefined {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return resolvePluginCapabilityProvider({
    key: "realtimeVoiceProviders",
    providerId: normalized,
    cfg,
  });
}

export async function getRealtimeVoiceProviderAsync(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): Promise<RealtimeVoiceProviderPlugin | undefined> {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  using projection = createLegacyPluginSdkProviderProjection();
  const provider = await resolvePluginCapabilityProviderAsync(
    { key: "realtimeVoiceProviders", providerId: normalized, cfg },
    (registry) => projection.select(registry),
  );
  projection.adopt();
  return provider;
}

export async function canonicalizeRealtimeVoiceProviderIdAsync(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): Promise<RealtimeVoiceProviderId | undefined> {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  return normalized
    ? ((await getRealtimeVoiceProviderAsync(normalized, cfg))?.id ?? normalized)
    : undefined;
}
