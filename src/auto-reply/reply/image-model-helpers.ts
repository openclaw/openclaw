import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
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

    const trimmedSlash = trimmed.indexOf("/");

    // Add provider-qualified raw strings directly
    if (trimmedSlash > 0) {
      keys.add(trimmed);
    }

    // Also add providerless model names directly for cross-provider matching.
    if (trimmedSlash <= 0) {
      keys.add(trimmed);
    }

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
        if (!allowAny && !allowedKeys.has(trimmed)) {
          return null;
        }
        return trimmed;
      }

      const key = modelKey(resolved.ref.provider, resolved.ref.model);
      if (!allowAny && !allowedKeys.has(key) && !allowedKeys.has(trimmed)) {
        return null;
      }
      return key;
    })
    .filter((fb): fb is string => fb !== null);
}

/**
 * Extended parameters for collecting image model keys with fallback-derived provider.
 */
export type CollectImageModelKeysWithFallbackProviderParams = {
  imageModelConfig: AgentModelConfig | undefined;
  aliasIndex: ModelAliasIndex;
  defaultProvider: string;
  /** When true, use fallback-derived provider for providerless primary */
  useFallbackDerivedProvider?: boolean;
  /** The fallback-derived provider to use */
  imageModelProvider?: string;
  /** Alias index for fallback resolution */
  fallbackAliasIndex?: ModelAliasIndex;
};

/**
 * Collect image model keys with support for fallback-derived provider context.
 * This is a more flexible version for use in chat.ts where the provider context
 * depends on whether the primary was promoted from fallbacks.
 */
export function collectImageModelKeysWithContext(
  params: CollectImageModelKeysWithFallbackProviderParams,
): ImageModelKeysResult {
  const {
    imageModelConfig,
    aliasIndex,
    defaultProvider,
    useFallbackDerivedProvider = false,
    imageModelProvider: providedImageModelProvider,
    fallbackAliasIndex,
  } = params;

  const keys = new Set<string>();
  const noProviderValue = defaultProvider ?? "";
  if (!imageModelConfig) {
    return { keys, imageModelDefaultProvider: noProviderValue };
  }

  const imageModelPrimary = resolveAgentModelPrimaryValue(imageModelConfig);
  const fallbacks = resolveAgentModelFallbackValues(imageModelConfig);
  let imageModelDefaultProvider = providedImageModelProvider ?? "";

  // If no provider provided and we should use fallback-derived provider, scan fallbacks.
  if (!imageModelDefaultProvider) {
    const primaryTrimmed = imageModelPrimary?.trim() ?? "";
    const primaryHasProvider = primaryTrimmed.includes("/");

    // If primary has explicit provider, use it
    if (primaryHasProvider) {
      const resolved = resolveModelRefFromString({
        raw: primaryTrimmed,
        defaultProvider,
        aliasIndex,
      });
      if (resolved) {
        imageModelDefaultProvider = resolved.ref.provider;
      }
    } else if (!useFallbackDerivedProvider) {
      // Try to resolve providerless primary as alias
      const resolved = resolveModelRefFromString({
        raw: primaryTrimmed,
        defaultProvider,
        aliasIndex,
      });
      if (resolved?.alias && resolved.ref.provider) {
        imageModelDefaultProvider = resolved.ref.provider;
      }
    }

    // Scan fallbacks for provider
    if (!imageModelDefaultProvider) {
      for (const fb of fallbacks) {
        if (!fb?.trim()) {
          continue;
        }
        const slash = fb.indexOf("/");
        if (slash > 0) {
          imageModelDefaultProvider = fb.slice(0, slash).trim();
          break;
        }
      }
    }

    // Try alias resolution on fallbacks
    if (!imageModelDefaultProvider) {
      for (const fb of fallbacks) {
        if (!fb?.trim()) {
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

    const trimmedSlash = trimmed.indexOf("/");

    if (trimmedSlash > 0) {
      keys.add(trimmed);
    }

    if (trimmedSlash <= 0) {
      keys.add(trimmed);
    }

    // Use fallback-derived provider context when appropriate
    const useFallbackProvider = !isPrimary && useFallbackDerivedProvider && fallbackAliasIndex;
    const providerContext = useFallbackProvider
      ? imageModelDefaultProvider || defaultProvider
      : isPrimary
        ? defaultProvider
        : imageModelDefaultProvider || defaultProvider;
    const useAliasIndex = useFallbackProvider ? fallbackAliasIndex : aliasIndex;

    if (providerContext) {
      const resolved = resolveModelRefFromString({
        raw: trimmed,
        defaultProvider: providerContext,
        aliasIndex: useAliasIndex,
      });
      if (resolved) {
        keys.add(modelKey(resolved.ref.provider, resolved.ref.model));
      }
    }
  };

  if (imageModelPrimary) {
    addModelKey(imageModelPrimary, true);
  }
  for (const fb of fallbacks) {
    if (fb?.trim()) {
      addModelKey(fb, false);
    }
  }

  return { keys, imageModelDefaultProvider };
}

/**
 * Parameters for resolving channel model vision support.
 */
export type ResolveChannelModelSupportsVisionParams = {
  channelModelOverride: { model: string } | undefined;
  imageModelConfig: AgentModelConfig | undefined;
  defaultProvider: string;
  cfg: OpenClawConfig;
  hasAppliedImageModelOverride: boolean;
  loadModelCatalog: () => Promise<import("../../agents/model-catalog.js").ModelCatalogEntry[]>;
};

/**
 * Result of checking if channel model supports vision.
 */
export type ResolveChannelModelSupportsVisionResult = {
  channelModelIsVisionModel: boolean;
  channelResolved?: {
    provider: string;
    model: string;
  };
};

/**
 * Check if the channel model override is already a vision model.
 * This prevents unnecessary model switching when the channel model
 * already supports image input.
 *
 * Returns channelModelIsVisionModel=true if:
 * 1. The channel model matches the configured imageModel or fallbacks, OR
 * 2. The catalog indicates the channel model supports vision
 */
export async function resolveChannelModelSupportsVision(
  params: ResolveChannelModelSupportsVisionParams,
): Promise<ResolveChannelModelSupportsVisionResult> {
  const {
    channelModelOverride,
    imageModelConfig,
    defaultProvider,
    cfg,
    hasAppliedImageModelOverride,
    // loadModelCatalog is part of the params interface but not used in this implementation.
    // The catalog is loaded via loadCatalogFn below when needed.
    loadModelCatalog: _loadModelCatalog,
  } = params;

  if (!channelModelOverride || !hasAppliedImageModelOverride) {
    return { channelModelIsVisionModel: false };
  }

  const { buildModelAliasIndex } = await import("../../agents/model-selection.js");
  const {
    findModelInCatalog,
    modelSupportsVision,
    loadModelCatalog: loadCatalogFn,
  } = await import("../../agents/model-catalog.js");
  const { resolveAgentModelFallbackValues, resolveAgentModelPrimaryValue } =
    await import("../../config/model-input.js");

  // Use the active default provider when building the alias index so that
  // aliases defined on providerless model keys resolve correctly.
  const channelAliasIndex = buildModelAliasIndex({ cfg, defaultProvider });

  // Resolve the channel model to get provider/model
  const { resolveModelRefFromString, modelKey } = await import("../../agents/model-selection.js");
  const channelResolved = resolveModelRefFromString({
    raw: channelModelOverride.model,
    defaultProvider,
    aliasIndex: channelAliasIndex,
  });

  if (!channelResolved) {
    return { channelModelIsVisionModel: false };
  }

  // First, check if the channel model matches the configured imageModel or its fallbacks
  const imageModelPrimary = resolveAgentModelPrimaryValue(imageModelConfig);
  const fallbacks = resolveAgentModelFallbackValues(imageModelConfig);

  // Process if either primary or fallbacks are configured (handles fallback-only configs)
  if (imageModelPrimary || fallbacks.length > 0) {
    const { keys: imageModelKeys } = collectImageModelKeys({
      imageModelConfig,
      aliasIndex: channelAliasIndex,
      defaultProvider,
    });

    const channelKey = modelKey(channelResolved.ref.provider, channelResolved.ref.model);

    // Resolve channel override using the same provider context as channelResolved.
    const channelOverrideResolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex: channelAliasIndex,
    });

    // When channel override can't be resolved (no alias match), use the channel's
    // provider to construct the key.
    const channelOverrideKey = channelOverrideResolved
      ? modelKey(channelOverrideResolved.ref.provider, channelOverrideResolved.ref.model)
      : modelKey(channelResolved.ref.provider, channelModelOverride.model);

    if (imageModelKeys.has(channelKey) || imageModelKeys.has(channelOverrideKey)) {
      return { channelModelIsVisionModel: true, channelResolved: channelResolved.ref };
    }
  }

  // If not found in imageModel list, check catalog for vision capabilities
  try {
    const catalog = await loadCatalogFn({ config: cfg });
    const catalogEntry = findModelInCatalog(
      catalog,
      channelResolved.ref.provider,
      channelResolved.ref.model,
    );
    if (modelSupportsVision(catalogEntry)) {
      return { channelModelIsVisionModel: true, channelResolved: channelResolved.ref };
    }
  } catch {
    // Catalog lookup failed; fall back to text-only assumption
  }

  return { channelModelIsVisionModel: false, channelResolved: channelResolved.ref };
}
