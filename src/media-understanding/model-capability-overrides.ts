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
