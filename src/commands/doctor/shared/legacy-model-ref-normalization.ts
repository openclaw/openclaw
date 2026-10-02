import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { normalizeAgentModelRefForConfig } from "../../../config/model-input.js";

// Spelling aliases preserve model identity; retirement belongs to the route-aware repair owner.
function canonicalizeKnownModelRef(value: string): string | null {
  const split = splitTrailingAuthProfile(value.trim());
  const slash = split.model.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const provider = split.model.slice(0, slash).trim();
  const model = split.model.slice(slash + 1).trim();
  return normalizeString(provider) === "openai" && normalizeString(model) === "gpt-5.6"
    ? `${provider}/gpt-5.6-sol${split.profile ? `@${split.profile}` : ""}`
    : null;
}

export function normalizeKnownModelRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return value === trimmed ? null : trimmed;
  }
  const split = splitTrailingAuthProfile(trimmed);
  const slash = split.model.indexOf("/");
  const provider = slash > 0 ? normalizeString(split.model.slice(0, slash)) : "";
  const modelId = slash > 0 ? split.model.slice(slash + 1) : split.model;
  const normalizedModel =
    provider === "google" ||
    provider === "google-gemini-cli" ||
    provider === "google-vertex" ||
    provider === "together" ||
    normalizeString(modelId).startsWith("google/")
      ? normalizeAgentModelRefForConfig(split.model)
      : split.model;
  const normalized = `${normalizedModel}${split.profile ? `@${split.profile}` : ""}`;
  return canonicalizeKnownModelRef(normalized) ?? (normalized === value ? null : normalized);
}

export function normalizeProviderCatalogModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  const normalizedProvider = normalizeString(provider);
  const normalized =
    normalizedProvider === "google" ||
    normalizedProvider === "google-gemini-cli" ||
    normalizedProvider === "google-vertex" ||
    normalizedProvider === "together" ||
    normalizeString(trimmed).startsWith("google/")
      ? normalizeConfiguredProviderCatalogModelId(provider, trimmed)
      : trimmed;
  const upgradedRef = canonicalizeKnownModelRef(`${provider}/${normalized}`);
  if (!upgradedRef) {
    return normalized;
  }
  const slash = upgradedRef.indexOf("/");
  return slash > 0 && normalizeString(upgradedRef.slice(0, slash)) === normalizeString(provider)
    ? upgradedRef.slice(slash + 1)
    : normalized;
}
