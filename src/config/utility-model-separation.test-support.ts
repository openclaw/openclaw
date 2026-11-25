import type { ModelProviderConfig } from "./types.models.js";

export function localProvider(...ids: string[]): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    models: (ids.length ? ids : ["small"]).map((id) => ({
      id,
      name: "Local fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    })),
  };
}
