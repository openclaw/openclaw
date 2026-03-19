export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai/";
export const DEEPINFRA_DEFAULT_MODEL_ID = "openai/gpt-oss-120b";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;
export const DEEPINFRA_DEFAULT_MODEL_NAME = "gpt-oss-120b";
export type DeepInfraModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

/**
 * Static fallback catalog used by the sync onboarding path and as a
 * fallback when dynamic model discovery from the gateway API fails.
 * The full model list is fetched dynamically by {@link discoverDeepInfraModels}
 * in `src/agents/deepinfra-models.ts`.
 */
export const DEEPINFRA_MODEL_CATALOG: DeepInfraModelCatalogEntry[] = [
  {
    id: DEEPINFRA_DEFAULT_MODEL_ID,
    name: DEEPINFRA_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 131072,
  },
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 196608,
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM 5",
    reasoning: true,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 202752,
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
  },
];
export const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
export const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;
export const DEEPINFRA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
