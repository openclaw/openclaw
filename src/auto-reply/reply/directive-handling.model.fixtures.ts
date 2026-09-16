import type { ModelDefinitionConfig } from "../../config/types.models.js";

export function modelDefinition(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}
