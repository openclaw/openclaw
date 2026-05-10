import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { isModelKeyAllowedBySet } from "../../agents/model-selection-shared.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";

/**
 * Result of collecting image model keys from config.
 */
export type ImageModelKeysResult = {
  keys: Set<string>;
  imageModelDefaultProvider: string;
};

/**
 * Parameters for collecting image model keys.
 */
export type CollectImageModelKeysParams = {
  imageModelConfig: AgentModelConfig | undefined;
  aliasIndex?: ModelAliasIndex;
  defaultProvider?: string;
  /**
   * When true and primary is providerless, try to resolve as alias first.
   * This handles cases like primary: "vision" -> "openai/gpt-4o".
   * Default: true
   */
  resolveProviderlessAsAlias?: boolean;
};

/**
 * Collect all configured image models (primary + fallbacks) into a Set of model keys.
 * Resolves aliases using aliasIndex and the image model's own provider context.
 * Returns a Set of both raw strings and resolved "provider/model" keys.
 * Also adds providerless model names so isImageModel can match across providers.
 */
export function collectImageModelKeys(params: CollectImageModelKeysParams): ImageModelKeysResult {
  const {
    imageModelConfig,
    aliasIndex,
    defaultProvider,
    resolveProviderlessAsAlias = true,
  } = params;
  const keys = new Set<string>();
  const noProviderValue = defaultProvider ?? "";
  if (!imageModelConfig) {
    return { keys, imageModelDefaultProvider: noProviderValue };
  }

  const imageModelPrimary = resolveAgentModelPrimaryValue(imageModelConfig);

  // Resolve the image model's primary to get its provider for fallback resolution.
  // Providerless fallbacks should resolve against the image model's provider,
  // not the agent's default provider (to handle mixed-provider configs correctly).
  let imageModelDefaultProvider = "";
  const primaryTrimmed = imageModelPrimary?.trim() ?? "";
  const primaryHasProvider = primaryTrimmed.includes("/");

  // Only derive imageModelDefaultProvider from imageModelPrimary if it has an explicit provider.
  if (imageModelPrimary && aliasIndex && defaultProvider && primaryHasProvider) {
    const resolved = resolveModelRefFromString({
      raw: primaryTrimmed,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      imageModelDefaultProvider = resolved.ref.provider;
    }
  }

  // If no primary was configured or the primary is providerless, derive
  // imageModelDefaultProvider from fallbacks.
  if ((!imageModelPrimary || !primaryHasProvider) && aliasIndex && !imageModelDefaultProvider) {
    const fallbacks =
      typeof imageModelConfig === "string"
        ? [imageModelConfig]
        : Array.isArray(imageModelConfig?.fallbacks)
          ? imageModelConfig.fallbacks
          : [];

    // First pass: try to resolve providerless primary alias to get its provider.
    if (!primaryHasProvider && imageModelPrimary && defaultProvider && resolveProviderlessAsAlias) {
      const resolved = resolveModelRefFromString({
        raw: primaryTrimmed,
        defaultProvider,
        aliasIndex,
      });
      if (resolved?.alias) {
        imageModelDefaultProvider = resolved.ref.provider;
      }
    }

    // Second pass: find the first fallback with an explicit provider
    if (!imageModelDefaultProvider) {
      for (const fb of fallbacks) {
        if (typeof fb !== "string" || !fb.trim()) {
          continue;
        }
        const slash = fb.indexOf("/");
        if (slash > 0) {
          imageModelDefaultProvider = fb.slice(0, slash).trim();
          break;
        }
      }
    }

    // Third pass: if still no provider, use alias resolution on fallbacks
    if (!imageModelDefaultProvider && defaultProvider) {
      for (const fb of fallbacks) {
        if (typeof fb !== "string" || !fb.trim()) {
          continue;
        }
        const resolved = resolveModelRefFromString({
          raw: fb.trim(),
          defaultProvider,
          aliasIndex,
        });
        if (resolved?.alias && resolved.ref.provider) {
          imageModelDefaultProvider = resolved.ref.provider;
          break;
        }
      }
    }
  }

  const addModelKey = (rawModel: string, isPrimary: boolean) => {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return;
    }

    // Add raw model string directly for matching (both provider-qualified and providerless).
    keys.add(trimmed);

    // Resolve alias and add canonical key.
    const providerContext = isPrimary
      ? defaultProvider
      : imageModelDefaultProvider || defaultProvider;
    if (aliasIndex && providerContext) {
      const resolved = resolveModelRefFromString({
        raw: trimmed,
        defaultProvider: providerContext,
        aliasIndex,
      });
      if (resolved) {
        keys.add(modelKey(resolved.ref.provider, resolved.ref.model));
      }
    }
  };

  if (typeof imageModelConfig === "string") {
    addModelKey(imageModelConfig, true);
  } else {
    if (imageModelPrimary?.trim()) {
      addModelKey(imageModelPrimary, true);
    }
    if (Array.isArray(imageModelConfig.fallbacks)) {
      for (const fb of imageModelConfig.fallbacks) {
        if (fb?.trim()) {
          addModelKey(fb, false);
        }
      }
    }
  }
  return { keys, imageModelDefaultProvider };
}

/**
 * Check if a given provider/model combination is in the set of image models.
 */
export function isImageModel(
  provider: string,
  model: string,
  imageModelKeys: Set<string>,
): boolean {
  const effectiveProvider = provider;
  const pureModel = model;

  // 1. Check exact provider/model key match
  const key = modelKey(effectiveProvider, pureModel);
  if (imageModelKeys.has(key)) {
    return true;
  }

  // 2. Check stored model string directly against provider-qualified entries
  if (imageModelKeys.has(model)) {
    return true;
  }

  // 3. Match against all entries in imageModelKeys
  for (const entry of imageModelKeys) {
    const slash = entry.indexOf("/");
    if (slash <= 0) {
      // Providerless entry - matches any provider with the same model name.
      if (entry === pureModel) {
        return true;
      }
    } else {
      // Provider-qualified entry - match by pure name with provider alignment
      const entryPureModel = entry.slice(slash + 1);
      if (entryPureModel === pureModel) {
        const entryProvider = entry.slice(0, slash);
        if (effectiveProvider === entryProvider) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Parameters for preparing image model fallbacks.
 */
export type PrepareImageModelFallbacksParams = {
  fallbacks: string[];
  cfg: OpenClawConfig;
  agentId?: string;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  defaultProvider: string;
  defaultModel?: string;
  imageModelProvider?: string;
};

/**
 * Filter and canonicalize image model fallbacks in one step.
 * Combines allowlist filtering with provider-aware canonicalization.
 */
export function prepareImageModelFallbacks(params: PrepareImageModelFallbacksParams): string[] {
  const { fallbacks, cfg, agentId, aliasIndex, defaultProvider, defaultModel, imageModelProvider } =
    params;

  if (fallbacks.length === 0) {
    return [];
  }

  const providerForResolution = imageModelProvider ?? defaultProvider;
  const { allowAny, allowedKeys } = buildAllowedModelSet({
    cfg,
    catalog: [],
    defaultProvider,
    defaultModel,
    agentId,
  });

  return fallbacks
    .map((fb) => {
      const trimmed = fb?.trim();
      if (!trimmed) {
        return null;
      }

      const resolved = resolveModelRefFromString({
        raw: trimmed,
        defaultProvider: providerForResolution,
        aliasIndex,
      });

      if (!resolved) {
        return null;
      }

      const key = modelKey(resolved.ref.provider, resolved.ref.model);
      if (!allowAny && !isModelKeyAllowedBySet(allowedKeys, key) && !allowedKeys.has(trimmed)) {
        return null;
      }
      return key;
    })
    .filter((fb): fb is string => fb !== null);
}

export type ResolveModelSupportsVisionParams = {
  provider: string;
  model: string;
  imageModelConfig?: AgentModelConfig;
  defaultProvider: string;
  cfg: OpenClawConfig;
  loadModelCatalog?: (params: { config: OpenClawConfig }) => Promise<ModelCatalogEntry[]>;
};

export async function resolveModelSupportsVision(
  params: ResolveModelSupportsVisionParams,
): Promise<boolean> {
  const {
    provider,
    model,
    imageModelConfig,
    defaultProvider,
    cfg,
    loadModelCatalog: loadCatalog,
  } = params;

  try {
    const { findModelInCatalog, loadModelCatalog, modelSupportsVision } =
      await import("../../agents/model-catalog.js");
    const catalog = await (loadCatalog ?? loadModelCatalog)({ config: cfg });
    const catalogEntry = findModelInCatalog(catalog, provider, model);

    // If the catalog has an entry for this model, trust its vision capability flag.
    if (catalogEntry !== undefined) {
      return modelSupportsVision(catalogEntry);
    }
  } catch {
    // Catalog lookup failed; fall through to config-based detection.
  }

  // Catalog does not contain this model (or lookup failed). Fall back to
  // imageModel config as a lenient signal — the user may have configured a
  // custom or provider-specific model that the catalog does not yet cover.
  if (imageModelConfig) {
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider });
    const { keys: imageModelKeys } = collectImageModelKeys({
      imageModelConfig,
      aliasIndex,
      defaultProvider,
    });
    if (isImageModel(provider, model, imageModelKeys)) {
      return true;
    }
  }
  return false;
}
