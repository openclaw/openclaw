import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";

export type ProviderModelIdNormalizationParams = Parameters<
  typeof normalizeProviderModelIdWithManifest
>[0];

/** Retained and cold lookups share hook receiver, error, and manifest fallback semantics. */
export function normalizeProviderModelIdWithResolvedPlugin(
  params: ProviderModelIdNormalizationParams,
  plugin: ProviderPlugin | undefined,
): string | undefined {
  return (
    normalizeOptionalString(plugin?.normalizeModelId?.(params.context)) ??
    normalizeProviderModelIdWithManifest(params)
  );
}
