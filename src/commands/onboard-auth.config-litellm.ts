import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { LITELLM_DEFAULT_MODEL_REF } from "../plugins/provider-auth-storage.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "../plugins/provider-onboarding-config.js";

export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
// Fallback context window used only when the provider config does not include
// a model-reported value.  Most LiteLLM deployments proxy models that report
// their own context window; this constant is a safe last-resort default.
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128_000;
const LITELLM_DEFAULT_MAX_TOKENS = 8_192;
const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Resolve the context window for the default LiteLLM model.
 *
 * Preference order:
 *  1. The contextWindow already defined on the matching model in the existing
 *     provider config (i.e. a value the user or LiteLLM model-info reported).
 *  2. {@link LITELLM_DEFAULT_CONTEXT_WINDOW} as a last-resort fallback.
 */
function resolveLitellmContextWindow(existingModels: ModelDefinitionConfig[] | undefined): number {
  if (existingModels) {
    const match = existingModels.find((m) => m.id === LITELLM_DEFAULT_MODEL_ID);
    if (match && typeof match.contextWindow === "number" && match.contextWindow > 0) {
      return match.contextWindow;
    }
  }
  return LITELLM_DEFAULT_CONTEXT_WINDOW;
}

function buildLitellmModelDefinition(contextWindow: number): {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
} {
  return {
    id: LITELLM_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: LITELLM_DEFAULT_COST,
    contextWindow,
    maxTokens: LITELLM_DEFAULT_MAX_TOKENS,
  };
}

export function applyLitellmProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[LITELLM_DEFAULT_MODEL_REF] = {
    ...models[LITELLM_DEFAULT_MODEL_REF],
    alias: models[LITELLM_DEFAULT_MODEL_REF]?.alias ?? "LiteLLM",
  };

  const existingProvider = cfg.models?.providers?.litellm as
    | { baseUrl?: unknown; models?: ModelDefinitionConfig[] }
    | undefined;
  const resolvedContextWindow = resolveLitellmContextWindow(existingProvider?.models);
  const defaultModel = buildLitellmModelDefinition(resolvedContextWindow);
  const resolvedBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "litellm",
    api: "openai-completions",
    baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
    defaultModel,
    defaultModelId: LITELLM_DEFAULT_MODEL_ID,
  });
}

export function applyLitellmConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyLitellmProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, LITELLM_DEFAULT_MODEL_REF);
}
