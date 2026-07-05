// Registers music generation provider runtimes by normalized provider id.
<<<<<<< HEAD
import type { OpenClawConfig } from "../config/types.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
=======
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { MusicGenerationProviderPlugin } from "../plugins/types.js";

/**
 * Registry for music generation providers.
 *
 * Built-ins and plugin-provided capability providers share one alias map while
 * rejecting unsafe object keys before they reach Maps or config-derived lookups.
 */
const BUILTIN_MUSIC_GENERATION_PROVIDERS: readonly MusicGenerationProviderPlugin[] = [];
<<<<<<< HEAD
=======
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeMusicGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  if (!normalized || isBlockedObjectKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function isSafeMusicGenerationProviderId(id: string | undefined): id is string {
  // Keep prototype-pollution sentinel names out even after normal provider-id normalization.
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

function resolvePluginMusicGenerationProviders(
  cfg?: OpenClawConfig,
): MusicGenerationProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "musicGenerationProviders",
    cfg,
  });
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, MusicGenerationProviderPlugin>;
  aliases: Map<string, MusicGenerationProviderPlugin>;
} {
<<<<<<< HEAD
  return buildCapabilityProviderMaps(
    [...BUILTIN_MUSIC_GENERATION_PROVIDERS, ...resolvePluginMusicGenerationProviders(cfg)],
    normalizeCapabilityProviderId,
  );
=======
  const canonical = new Map<string, MusicGenerationProviderPlugin>();
  const aliases = new Map<string, MusicGenerationProviderPlugin>();
  const register = (provider: MusicGenerationProviderPlugin) => {
    const id = normalizeMusicGenerationProviderId(provider.id);
    if (!isSafeMusicGenerationProviderId(id)) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeMusicGenerationProviderId(alias);
      if (isSafeMusicGenerationProviderId(normalizedAlias)) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of BUILTIN_MUSIC_GENERATION_PROVIDERS) {
    register(provider);
  }
  for (const provider of resolvePluginMusicGenerationProviders(cfg)) {
    register(provider);
  }

  return { canonical, aliases };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

/** List canonical music generation providers available for the current config. */
export function listMusicGenerationProviders(
  cfg?: OpenClawConfig,
): MusicGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

/** Resolve a music generation provider by canonical id or alias. */
export function getMusicGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): MusicGenerationProviderPlugin | undefined {
<<<<<<< HEAD
  const normalized = normalizeCapabilityProviderId(providerId);
=======
  const normalized = normalizeMusicGenerationProviderId(providerId);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
