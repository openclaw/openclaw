import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getActivePluginRegistry, getActivePluginRegistryKey } from "../plugins/runtime.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";

const BUILTIN_IMAGE_GENERATION_PROVIDERS: readonly ImageGenerationProviderPlugin[] = [];

function normalizeImageGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  return normalized || undefined;
}

function resolvePluginImageGenerationProviders(
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin[] {
  const active = getActivePluginRegistry();
  const registry =
    getActivePluginRegistryKey() || !cfg ? active : loadOpenClawPlugins({ config: cfg });
  return registry?.imageGenerationProviders?.map((entry) => entry.provider) ?? [];
}

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, ImageGenerationProviderPlugin>;
  aliases: Map<string, ImageGenerationProviderPlugin>;
} {
  const canonical = new Map<string, ImageGenerationProviderPlugin>();
  const aliases = new Map<string, ImageGenerationProviderPlugin>();
  const register = (provider: ImageGenerationProviderPlugin) => {
    const id = normalizeImageGenerationProviderId(provider.id);
    if (!id) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeImageGenerationProviderId(alias);
      if (normalizedAlias) {
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
}

export function listImageGenerationProviders(
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getImageGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin | undefined {
  const normalized = normalizeImageGenerationProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
