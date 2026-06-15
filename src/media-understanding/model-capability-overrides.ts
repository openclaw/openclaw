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
