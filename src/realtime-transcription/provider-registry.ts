import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createMediaProviderRegistry } from "../media-generation/provider-registry.js";
import {
  resolvePluginCapabilityProviderAsync,
  resolvePluginCapabilityProvidersAsync,
} from "../plugins/capability-provider-runtime.js";
import { createLegacyPluginSdkProviderProjection } from "../plugins/legacy-sdk-provider-projection.js";
import {
  buildCapabilityProviderIndex,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { RealtimeTranscriptionProviderId } from "./provider-types.js";

export { normalizeCapabilityProviderId as normalizeRealtimeTranscriptionProviderId };

const registry = createMediaProviderRegistry("realtimeTranscriptionProviders", {
  directLookup: true,
});

function warnSyncTranscriptionRegistry(method: string, replacement: string): void {
  warnPluginSdkDeprecation({
    family: "realtime-transcription-registry-sync",
    method,
    replacement,
    compatibility:
      "The synchronous API requires already prepared and loaded transcription providers.",
  });
}

/** @deprecated Await listRealtimeTranscriptionProvidersAsync; synchronous reads require loaded providers. */
export function listRealtimeTranscriptionProviders(
  cfg?: OpenClawConfig,
  additionalProviderIds?: readonly string[],
) {
  warnSyncTranscriptionRegistry(
    "listRealtimeTranscriptionProviders",
    "listRealtimeTranscriptionProvidersAsync",
  );
  return registry.listProviders(cfg, additionalProviderIds);
}

export async function listRealtimeTranscriptionProvidersAsync(
  cfg?: OpenClawConfig,
  additionalProviderIds?: readonly string[],
) {
  using projection = createLegacyPluginSdkProviderProjection();
  const providers = await resolvePluginCapabilityProvidersAsync(
    { key: "realtimeTranscriptionProviders", cfg, additionalProviderIds },
    (selected) => projection.select(selected),
  );
  projection.adopt();
  return [...buildCapabilityProviderIndex(providers, "canonical").values()];
}

/** @deprecated Await getRealtimeTranscriptionProviderAsync; synchronous reads require loaded providers. */
export function getRealtimeTranscriptionProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
) {
  warnSyncTranscriptionRegistry(
    "getRealtimeTranscriptionProvider",
    "getRealtimeTranscriptionProviderAsync",
  );
  return registry.getProvider(providerId, cfg);
}

export async function getRealtimeTranscriptionProviderAsync(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
) {
  const normalized = normalizeCapabilityProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  using projection = createLegacyPluginSdkProviderProjection();
  const provider = await resolvePluginCapabilityProviderAsync(
    { key: "realtimeTranscriptionProviders", providerId: normalized, cfg },
    (selected) => projection.select(selected),
  );
  projection.adopt();
  return provider;
}

/** Canonicalizes a configured provider id while preserving unknown ids. */
export async function canonicalizeRealtimeTranscriptionProviderIdAsync(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): Promise<RealtimeTranscriptionProviderId | undefined> {
  const normalized = normalizeCapabilityProviderId(providerId);
  return normalized
    ? ((await getRealtimeTranscriptionProviderAsync(normalized, cfg))?.id ?? normalized)
    : undefined;
}
