// Generic provider-owned model capability helpers.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { MediaUnderstandingProviderModelCapabilities } from "./model-capability-overrides.js";

type ModelCapabilityProvider = MediaUnderstandingProviderModelCapabilities;

function normalizeModelId(modelId: string): string {
  return normalizeLowercaseStringOrEmpty(modelId);
}

function modelIdCandidates(modelId: string, providerId: string): string[] {
  const normalized = normalizeModelId(modelId);
  const prefix = providerId ? `${providerId}/` : "";
  const local =
    prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  return local === normalized ? [normalized] : [normalized, local];
}

export function isKnownNonImageModel(params: {
  modelId: string;
  provider?: ModelCapabilityProvider;
}): boolean {
  const providerId = normalizeLowercaseStringOrEmpty(params.provider?.id ?? "");
  const modelIds = modelIdCandidates(params.modelId, providerId).filter(Boolean);
  if (modelIds.length === 0) {
    return false;
  }
  const overrides = params.provider?.modelCapabilityOverrides;
  if (!overrides) {
    return false;
  }
  const exact = new Set(
    (overrides.nonImageModels ?? []).flatMap((id) => modelIdCandidates(id, providerId)),
  );
  if (modelIds.some((modelId) => exact.has(modelId))) {
    return true;
  }
  const families = (overrides.nonImageModelFamilies ?? []).flatMap((family) =>
    modelIdCandidates(family, providerId),
  );
  return modelIds.some((modelId) =>
    families.some((family) => family && (modelId === family || modelId.startsWith(`${family}-`))),
  );
}

export function configuredModelInputSupportsImage(params: {
  modelId: string;
  input?: readonly string[];
  provider?: ModelCapabilityProvider;
}): boolean {
  return (
    Array.isArray(params.input) && params.input.includes("image") && !isKnownNonImageModel(params)
  );
}
