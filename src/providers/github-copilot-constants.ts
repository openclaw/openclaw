import type { ModelDefinitionConfig } from "../config/types.js";

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
export const COPILOT_GPT_54_MODEL_ID = "gpt-5.4";
// Copilot docs advertise a 1M-token window for GPT-5.4; keep provider metadata
// aligned with that public limit even though OpenAI's direct forward-compat path
// uses a slightly larger experimental value.
export const COPILOT_GPT_54_CONTEXT_WINDOW = 1_000_000;
export const COPILOT_GPT_54_MAX_TOKENS = 128_000;

const DEFAULT_COPILOT_CONTEXT_WINDOW = 128_000;
const DEFAULT_COPILOT_MAX_TOKENS = 8192;
const DEFAULT_COPILOT_MODEL_INPUT: ModelDefinitionConfig["input"] = ["text", "image"];
const DEFAULT_COPILOT_MODEL_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildCopilotModelMetadata(
  modelId: string,
): Pick<ModelDefinitionConfig, "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"> {
  if (modelId.trim().toLowerCase() === COPILOT_GPT_54_MODEL_ID) {
    return {
      reasoning: true,
      input: [...DEFAULT_COPILOT_MODEL_INPUT],
      cost: { ...DEFAULT_COPILOT_MODEL_COST },
      contextWindow: COPILOT_GPT_54_CONTEXT_WINDOW,
      maxTokens: COPILOT_GPT_54_MAX_TOKENS,
    };
  }

  return {
    reasoning: false,
    input: [...DEFAULT_COPILOT_MODEL_INPUT],
    cost: { ...DEFAULT_COPILOT_MODEL_COST },
    contextWindow: DEFAULT_COPILOT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_COPILOT_MAX_TOKENS,
  };
}
