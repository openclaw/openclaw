import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import { coerceToolModelConfig, type ToolModelConfig } from "./model-config.helpers.js";

export type ImageModelConfig = ToolModelConfig;

export function coerceImageModelConfig(cfg?: OpenClawConfig): ImageModelConfig {
  return coerceToolModelConfig(cfg?.agents?.defaults?.imageModel);
}

export function resolveConfiguredImageModelRefs(params: {
  cfg?: OpenClawConfig;
  imageModelConfig: ImageModelConfig;
}): ImageModelConfig {
  const primary = params.imageModelConfig.primary?.trim();
  const matchesByRef = new Map<string, Set<string>>();
  for (const rawRef of [...(params.imageModelConfig.fallbacks ?? []), primary ?? ""]) {
    const ref = rawRef.trim();
    if (ref && !ref.includes("/")) {
      matchesByRef.set(normalizeLowercaseStringOrEmpty(ref), new Set());
    }
  }

  if (matchesByRef.size > 0) {
    for (const [providerKey, providerConfig] of Object.entries(
      params.cfg?.models?.providers ?? {},
    )) {
      const provider = normalizeProviderId(providerKey);
      if (!provider || !Array.isArray(providerConfig?.models)) {
        continue;
      }
      for (const entry of providerConfig.models) {
        const modelId = entry?.id?.trim();
        if (!modelId || !Array.isArray(entry?.input) || !entry.input.includes("image")) {
          continue;
        }
        const slash = modelId.indexOf("/");
        const providerPrefixed =
          slash > 0 && normalizeProviderId(modelId.slice(0, slash)) === provider;
        const ref = providerPrefixed ? modelId.slice(slash + 1) : modelId;
        matchesByRef
          .get(normalizeLowercaseStringOrEmpty(ref))
          ?.add(providerPrefixed ? modelId : `${provider}/${modelId}`);
      }
    }
  }

  const resolveRef = (rawRef: string): string => {
    const ref = rawRef.trim();
    if (!ref || ref.includes("/")) {
      return ref;
    }
    const matches = [...(matchesByRef.get(normalizeLowercaseStringOrEmpty(ref)) ?? [])];
    if (matches.length <= 1) {
      return matches.at(0) ?? ref;
    }
    throw new Error(
      `Ambiguous image model "${ref}". Configure a provider-prefixed ref such as ${matches
        .map((match) => `"${match}"`)
        .join(" or ")}.`,
    );
  };
  const fallbacks = params.imageModelConfig.fallbacks
    ?.map(resolveRef)
    .filter((ref) => ref.length > 0);

  return {
    ...(params.imageModelConfig.primary !== undefined
      ? {
          primary: primary ? resolveRef(primary) : primary,
        }
      : {}),
    ...(fallbacks && fallbacks.length > 0 ? { fallbacks } : {}),
    ...(params.imageModelConfig.timeoutMs !== undefined
      ? { timeoutMs: params.imageModelConfig.timeoutMs }
      : {}),
  };
}

export function resolveProviderVisionModelFromConfig(params: {
  cfg?: OpenClawConfig;
  provider: string;
}): string | null {
  if (isMinimaxVlmProvider(params.provider)) {
    return null;
  }
  const providerCfg = findNormalizedProviderValue(params.cfg?.models?.providers, params.provider);
  const models = providerCfg?.models ?? [];
  const picked = models.find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image"));
  const id = (picked?.id ?? "").trim();
  if (!id) {
    return null;
  }
  const slash = id.indexOf("/");
  const idProvider = slash === -1 ? "" : normalizeLowercaseStringOrEmpty(id.slice(0, slash));
  const selectedProvider = normalizeLowercaseStringOrEmpty(params.provider);
  return idProvider && idProvider === selectedProvider ? id : `${params.provider}/${id}`;
}
