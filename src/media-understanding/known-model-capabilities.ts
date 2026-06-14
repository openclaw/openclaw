// Generic provider-owned model capability helpers.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { MediaUnderstandingProvider } from "./types.js";

function localModelId(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

function normalizeModelId(modelId: string): string {
  return normalizeLowercaseStringOrEmpty(localModelId(modelId));
}

export function isKnownNonImageModel(params: {
  modelId: string;
  provider?: Pick<MediaUnderstandingProvider, "modelCapabilityOverrides">;
}): boolean {
  const modelId = normalizeModelId(params.modelId);
  if (!modelId) {
    return false;
  }
  const overrides = params.provider?.modelCapabilityOverrides;
  if (!overrides) {
    return false;
  }
  const exact = new Set((overrides.nonImageModels ?? []).map(normalizeModelId));
  if (exact.has(modelId)) {
    return true;
  }
  return (overrides.nonImageModelFamilies ?? [])
    .map(normalizeModelId)
    .some((family) => family && (modelId === family || modelId.startsWith(`${family}-`)));
}

export function configuredModelInputSupportsImage(params: {
  modelId: string;
  input?: readonly string[];
  provider?: Pick<MediaUnderstandingProvider, "modelCapabilityOverrides">;
}): boolean {
  return (
    Array.isArray(params.input) && params.input.includes("image") && !isKnownNonImageModel(params)
  );
}
