// Shares provider registry normalization helpers across plugin paths.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
<<<<<<< HEAD
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

/** Normalizes provider ids used by capability-provider registries. */
export function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(providerId);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : undefined;
=======

/** Normalizes provider ids used by capability-provider registries. */
export function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined {
  return normalizeOptionalLowercaseString(providerId);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

/** Builds canonical and alias lookup maps for capability providers. */
export function buildCapabilityProviderMaps<T extends { id: string; aliases?: readonly string[] }>(
  providers: readonly T[],
  normalizeId: (
    providerId: string | undefined,
  ) => string | undefined = normalizeCapabilityProviderId,
): {
  canonical: Map<string, T>;
  aliases: Map<string, T>;
} {
  const canonical = new Map<string, T>();
  const aliases = new Map<string, T>();

  for (const provider of providers) {
    const id = normalizeId(provider.id);
    if (!id) {
      continue;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeId(alias);
      if (normalizedAlias) {
        aliases.set(normalizedAlias, provider);
      }
    }
  }

  return { canonical, aliases };
}
