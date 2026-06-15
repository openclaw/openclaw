import { normalizeMediaProviderId } from "./provider-id.js";

export const QWEN_MODEL_CAPABILITY_PROVIDER_IDS = [
  "qwen",
  "qwencloud",
  "modelstudio",
  "dashscope",
] as const;

export const QWEN_MODEL_CAPABILITY_OVERRIDES = {
  nonImageModelFamilies: ["qwen3.7-max"],
} as const;

export type MediaUnderstandingModelCapabilityOverrides = {
  nonImageModels?: readonly string[];
  nonImageModelFamilies?: readonly string[];
};

export type MediaUnderstandingProviderModelCapabilities = {
  id?: string;
  modelCapabilityOverrides?: MediaUnderstandingModelCapabilityOverrides;
};

export function providerModelCapabilities(
  provider: unknown,
): MediaUnderstandingProviderModelCapabilities | undefined {
  if (!provider || typeof provider !== "object") {
    return undefined;
  }
  return provider as MediaUnderstandingProviderModelCapabilities;
}

export function knownProviderModelCapabilities(
  providerId: string,
): MediaUnderstandingProviderModelCapabilities | undefined {
  const normalizedProviderId = normalizeMediaProviderId(providerId);
  const qwenProviderIds: readonly string[] = QWEN_MODEL_CAPABILITY_PROVIDER_IDS;
  if (!qwenProviderIds.includes(normalizedProviderId)) {
    return undefined;
  }
  return {
    id: normalizedProviderId,
    modelCapabilityOverrides: QWEN_MODEL_CAPABILITY_OVERRIDES,
  };
}
