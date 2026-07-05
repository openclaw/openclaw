/** Registry for image-generation providers contributed by plugin capabilities. */
<<<<<<< HEAD
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
=======
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";

// Image-generation providers come from plugin capability registration. The
// registry keeps aliases separate from canonical ids for user config lookups.
const BUILTIN_IMAGE_GENERATION_PROVIDERS: readonly ImageGenerationProviderPlugin[] = [];
<<<<<<< HEAD
=======
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeImageGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  if (!normalized || isBlockedObjectKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function isSafeImageGenerationProviderId(id: string | undefined): id is string {
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
function resolvePluginImageGenerationProviders(
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin[] {
  return capabilityProviderRuntime.resolvePluginCapabilityProviders({
    key: "imageGenerationProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, ImageGenerationProviderPlugin>;
  aliases: Map<string, ImageGenerationProviderPlugin>;
} {
<<<<<<< HEAD
  return buildCapabilityProviderMaps(
    [...BUILTIN_IMAGE_GENERATION_PROVIDERS, ...resolvePluginImageGenerationProviders(cfg)],
    normalizeCapabilityProviderId,
  );
=======
  const canonical = new Map<string, ImageGenerationProviderPlugin>();
  const aliases = new Map<string, ImageGenerationProviderPlugin>();
  const register = (provider: ImageGenerationProviderPlugin) => {
    const id = normalizeImageGenerationProviderId(provider.id);
    if (!isSafeImageGenerationProviderId(id)) {
      return;
    }
    // Canonical list output is one entry per provider; aliases only affect
    // lookup so duplicate aliases cannot duplicate providers in UI/config.
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeImageGenerationProviderId(alias);
      if (isSafeImageGenerationProviderId(normalizedAlias)) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of BUILTIN_IMAGE_GENERATION_PROVIDERS) {
    register(provider);
  }
  for (const provider of resolvePluginImageGenerationProviders(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

/** Lists canonical image-generation providers visible for config. */
export function listImageGenerationProviders(
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

/** Resolves an image-generation provider by canonical id or alias. */
export function getImageGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin | undefined {
<<<<<<< HEAD
  const normalized = normalizeCapabilityProviderId(providerId);
=======
  const normalized = normalizeImageGenerationProviderId(providerId);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
