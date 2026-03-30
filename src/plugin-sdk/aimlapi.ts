import {
  AIMLAPI_BASE_URL,
  AIMLAPI_DEFAULT_CONTEXT_WINDOW,
  AIMLAPI_DEFAULT_COST,
  AIMLAPI_DEFAULT_MAX_TOKENS,
  AIMLAPI_DEFAULT_MODEL_ID,
  AIMLAPI_DEFAULT_MODEL_NAME,
  discoverAimlapiModels,
} from "../agents/aimlapi-models.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";

export type { ModelProviderConfig } from "../config/types.models.js";
export {
  AIMLAPI_BASE_URL,
  AIMLAPI_DEFAULT_CONTEXT_WINDOW,
  AIMLAPI_DEFAULT_COST,
  AIMLAPI_DEFAULT_MAX_TOKENS,
  AIMLAPI_DEFAULT_MODEL_ID,
  AIMLAPI_DEFAULT_MODEL_NAME,
  discoverAimlapiModels,
};

export const AIMLAPI_DEFAULT_MODEL_REF = "aimlapi/openai/gpt-5-nano-2025-08-07";

export function buildAimlapiModelDefinition(): ModelDefinitionConfig {
  return {
    id: AIMLAPI_DEFAULT_MODEL_ID,
    name: AIMLAPI_DEFAULT_MODEL_NAME,
    reasoning: false,
    input: ["text", "image"],
    cost: AIMLAPI_DEFAULT_COST,
    contextWindow: AIMLAPI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AIMLAPI_DEFAULT_MAX_TOKENS,
  };
}
