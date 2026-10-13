import { findCapabilityProviderById } from "../../packages/media-generation-core/src/capability-model-ref.js";
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import { acquirePluginCapabilityProviders } from "../plugins/capability-provider-acquisition.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import { resolveConfiguredMediaEntryCapabilities } from "./entry-capabilities.js";
import type { MediaUnderstandingCapabilityRegistry, MediaUnderstandingProvider } from "./types.js";

/** Resolves capability metadata for configured shared media model providers. */
function buildPreparedCapabilityRegistry(
  cfg: OpenClawConfig | undefined,
  providerIds: ReadonlySet<string>,
  preparedProviders: readonly MediaUnderstandingProvider[],
): MediaUnderstandingCapabilityRegistry {
  const registry: MediaUnderstandingCapabilityRegistry = new Map();
  for (const providerId of providerIds) {
    const provider = findCapabilityProviderById({
      providers: preparedProviders,
      providerId,
      normalizeProviderId: normalizeMediaProviderId,
    });
    if (provider) {
      // Keep canonical keys: runtime aliases do not independently opt entries into inference.
      registry.set(normalizeMediaProviderId(provider.id), { capabilities: provider.capabilities });
    }
  }
  for (const providerId of resolveImageCapableConfigProviderIds(cfg)) {
    // A runtime declaration owns capability truth, including an explicitly absent capability set.
    if (providerIds.has(providerId) && !registry.has(providerId)) {
      registry.set(providerId, { capabilities: ["image"] });
    }
  }
  return registry;
}

/** Loads only untagged configured providers before deriving their capability metadata. */
export async function buildMediaUnderstandingCapabilityRegistryAsync(cfg?: OpenClawConfig) {
  return await runWithAsyncWorkResources(async (onAcquired) => {
    const providerIds = new Set(
      (cfg?.tools?.media?.models ?? []).flatMap((entry) =>
        (entry.type ?? (entry.command ? "cli" : "provider")) === "provider" &&
        !resolveConfiguredMediaEntryCapabilities(entry) &&
        entry.provider?.trim()
          ? [normalizeMediaProviderId(entry.provider)]
          : [],
      ),
    );
    const acquisitions: Awaited<
      ReturnType<typeof acquirePluginCapabilityProviders<"mediaUnderstandingProviders">>
    >[] = [];
    onAcquired({
      release: async () => {
        await Promise.all(acquisitions.map((entry) => entry.release()));
      },
      releaseBeforeResultWhenIdle: true,
    });
    await Promise.all(
      [...providerIds].map(async (providerId) => {
        const acquired = await acquirePluginCapabilityProviders({
          key: "mediaUnderstandingProviders",
          providerId,
          cfg,
        });
        acquisitions.push(acquired);
      }),
    );
    return buildPreparedCapabilityRegistry(
      cfg,
      providerIds,
      acquisitions.flatMap(({ providers }) => providers),
    );
  });
}
