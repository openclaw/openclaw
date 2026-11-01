import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";

export function mediaModels(
  provider: string,
  model: string,
  input: ModelDefinitionConfig["input"],
  overrides: Partial<ModelProviderConfig> = {},
): { providers: Record<string, ModelProviderConfig> } {
  const definition: ModelDefinitionConfig = {
    id: model,
    name: model,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
  };
  return {
    providers: {
      [provider]: {
        baseUrl: "https://example.invalid/v1",
        models: [definition],
        ...overrides,
      },
    },
  };
}
