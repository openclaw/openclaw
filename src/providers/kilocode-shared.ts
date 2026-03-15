export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
export const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
export const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";
export type KilocodeModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};
/**
 * Static fallback catalog — used by the sync onboarding path and as a
 * fallback when dynamic model discovery from the gateway API fails.
 * The full model list is fetched dynamically by {@link discoverKilocodeModels}
 * in `src/agents/kilocode-models.ts`.
 */
export const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[] = [
  {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
];
export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1000000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 128000;
export const KILOCODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
