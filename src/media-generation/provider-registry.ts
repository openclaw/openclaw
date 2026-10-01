import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderIndex,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { PluginRegistry } from "../plugins/registry-types.js";

type MediaProviderRegistryKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "realtimeTranscriptionProviders"
  | "transcriptSourceProviders";

type MediaProvider<TKey extends MediaProviderRegistryKey> =
  PluginRegistry[TKey][number]["provider"];

/** Keeps provider lookups within one already-acquired operation scope. */
export function createMediaProviderLookup<T extends { id: string; aliases?: readonly string[] }>(
  providers: readonly T[],
) {
  const canonical = buildCapabilityProviderIndex(providers, "canonical");
  const aliases = buildCapabilityProviderIndex(providers, "aliases");
  return {
    getProvider: (id: string | undefined) => {
      const normalized = normalizeCapabilityProviderId(id);
      return normalized ? aliases.get(normalized) : undefined;
    },
    listProviders: () => [...canonical.values()],
  };
}

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
      // The capability runtime's private provider type uses this same registry mapping.
      capabilityProviderRuntime.resolvePluginCapabilityProviders({
        key,
        cfg,
        additionalProviderIds,
      }) as MediaProvider<TKey>[],
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
