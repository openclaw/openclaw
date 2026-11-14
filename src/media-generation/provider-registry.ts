import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderIndex,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";

type MediaProviderRegistryKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "realtimeTranscriptionProviders"
  | "transcriptSourceProviders";

/** Shares normalized provider listing while preserving targeted transcription lookup. */
export function createMediaProviderRegistry<TKey extends MediaProviderRegistryKey>(
  key: TKey,
  options: { directLookup?: boolean } = {},
) {
  const buildProviderIndex = (
    mode: "canonical" | "aliases",
    cfg?: OpenClawConfig,
    additionalProviderIds?: readonly string[],
  ) =>
    buildCapabilityProviderIndex(
      capabilityProviderRuntime.resolvePluginCapabilityProviders({
        key,
        cfg,
        additionalProviderIds,
      }),
      mode,
    );

  return {
    listProviders: (cfg?: OpenClawConfig, additionalProviderIds?: readonly string[]) => [
      ...buildProviderIndex("canonical", cfg, additionalProviderIds).values(),
    ],
    getProvider: (providerId: string | undefined, cfg?: OpenClawConfig) => {
      const normalized = normalizeCapabilityProviderId(providerId);
      if (!normalized) {
        return undefined;
      }
      return options.directLookup
        ? capabilityProviderRuntime.resolvePluginCapabilityProvider({
            key,
            providerId: normalized,
            cfg,
          })
        : buildProviderIndex("aliases", cfg).get(normalized);
    },
  };
}
