// Video provider registry stores video generation provider factories by id.
<<<<<<< HEAD
import type { OpenClawConfig } from "../config/types.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
=======
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";

// Video-generation providers come from plugin capability registration. Canonical
// ids drive listing; aliases only affect lookup.
const BUILTIN_VIDEO_GENERATION_PROVIDERS: readonly VideoGenerationProviderPlugin[] = [];
<<<<<<< HEAD
=======
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeVideoGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  if (!normalized || isBlockedObjectKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function isSafeVideoGenerationProviderId(id: string | undefined): id is string {
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
function resolvePluginVideoGenerationProviders(
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin[] {
  return capabilityProviderRuntime.resolvePluginCapabilityProviders({
    key: "videoGenerationProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, VideoGenerationProviderPlugin>;
  aliases: Map<string, VideoGenerationProviderPlugin>;
} {
<<<<<<< HEAD
  return buildCapabilityProviderMaps(
    [...BUILTIN_VIDEO_GENERATION_PROVIDERS, ...resolvePluginVideoGenerationProviders(cfg)],
    normalizeCapabilityProviderId,
  );
=======
  const canonical = new Map<string, VideoGenerationProviderPlugin>();
  const aliases = new Map<string, VideoGenerationProviderPlugin>();
  const register = (provider: VideoGenerationProviderPlugin) => {
    const id = normalizeVideoGenerationProviderId(provider.id);
    if (!isSafeVideoGenerationProviderId(id)) {
      return;
    }
    // Keep canonical provider listing de-duplicated even when multiple aliases
    // point at the same provider.
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeVideoGenerationProviderId(alias);
      if (isSafeVideoGenerationProviderId(normalizedAlias)) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of BUILTIN_VIDEO_GENERATION_PROVIDERS) {
    register(provider);
  }
  for (const provider of resolvePluginVideoGenerationProviders(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

export function listVideoGenerationProviders(
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getVideoGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin | undefined {
<<<<<<< HEAD
  const normalized = normalizeCapabilityProviderId(providerId);
=======
  const normalized = normalizeVideoGenerationProviderId(providerId);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
