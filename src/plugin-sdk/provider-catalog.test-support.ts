import type { ModelDefinitionConfig } from "./provider-model-shared.js";

export function buildCatalogModel(
  id: string,
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  };
}

export function catalogFixture(
  providerId: string,
  baseUrl: string,
  models: ModelDefinitionConfig[],
) {
  const providerConfig = { api: "openai-completions" as const, baseUrl, models };
  return { providerId, endpoint: `${baseUrl}/models`, providerConfig, models };
}

export const catalogResponse = (data: unknown, release: () => Promise<void>, finalUrl: string) => ({
  response: Response.json(data),
  release,
  finalUrl,
});
