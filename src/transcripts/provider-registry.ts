import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createMediaProviderLookup } from "../media-generation/provider-registry.js";
import {
  resolvePluginCapabilityProviderAsync,
  resolvePluginCapabilityProvidersAsync,
} from "../plugins/capability-provider-runtime.js";
import { normalizeCapabilityProviderId } from "../plugins/provider-registry-shared.js";
export { normalizeCapabilityProviderId as normalizeTranscriptSourceProviderId } from "../plugins/provider-registry-shared.js"; // Sanctioned domain alias.

/** Transcript providers use targeted lookup to avoid broad capability discovery. */
export async function getTranscriptSourceProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
) {
  const normalized = normalizeCapabilityProviderId(providerId);
  return normalized
    ? resolvePluginCapabilityProviderAsync({
        key: "transcriptSourceProviders",
        providerId: normalized,
        cfg,
      })
    : undefined;
}

export async function listTranscriptSourceProviders(
  cfg?: OpenClawConfig,
  additionalProviderIds?: readonly string[],
) {
  const providers = await resolvePluginCapabilityProvidersAsync({
    key: "transcriptSourceProviders",
    cfg,
    additionalProviderIds,
  });
  return createMediaProviderLookup(providers).listProviders();
}
