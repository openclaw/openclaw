export const MODEL_HUB_BASE_URL = "https://api.model-hub.cn/v1";
export const MODEL_HUB_DEFAULT_MODEL_ID = "gemini-3-flash-preview";
export const MODEL_HUB_DEFAULT_MODEL_NAME = "Model Hub Auto(Gemini 3 Flash Preview)";
export type ModelHubModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};
/**
 * Static fallback catalog — used by the sync onboarding path and as a
 * fallback when dynamic model discovery from the API fails.
 * The full model list is fetched dynamically by {@link discoverModelHubModels}
 * in `src/agents/model-hub-models.ts`.
 */
export const MODEL_HUB_MODEL_CATALOG: ModelHubModelCatalogEntry[] = [
  {
    id: MODEL_HUB_DEFAULT_MODEL_ID,
    name: MODEL_HUB_DEFAULT_MODEL_NAME,
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
];
export const MODEL_HUB_DEFAULT_CONTEXT_WINDOW = 128000;
export const MODEL_HUB_DEFAULT_MAX_TOKENS = 8192;
export const MODEL_HUB_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
