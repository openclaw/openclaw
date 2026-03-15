import { LITELLM_DEFAULT_MODEL_ID } from "../agents/litellm-models.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "./onboard-auth.config-shared.js";
import { LITELLM_DEFAULT_MODEL_REF } from "./onboard-auth.credentials.js";

export const LITELLM_BASE_URL = "http://localhost:4000";
export { LITELLM_DEFAULT_MODEL_ID };
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128_000;
const LITELLM_DEFAULT_MAX_TOKENS = 8_192;
const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function buildLitellmModelDefinition(): {
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
    contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LITELLM_DEFAULT_MAX_TOKENS,
  };
}

export function applyLitellmProviderConfig(
  cfg: OpenClawConfig,
  overrides?: { baseUrl?: string; modelId?: string },
): OpenClawConfig {
  const modelId = overrides?.modelId || LITELLM_DEFAULT_MODEL_ID;
  const modelRef = `litellm/${modelId}`;

  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? "LiteLLM",
  };

  const defaultModel = buildLitellmModelDefinition();
  if (modelId !== LITELLM_DEFAULT_MODEL_ID) {
    defaultModel.id = modelId;
    defaultModel.name = modelId;
    // Non-default models: use conservative capabilities since we don't
    // know the actual backend model's features
    defaultModel.reasoning = false;
    defaultModel.input = ["text"];
  }

  const existingProvider = cfg.models?.providers?.litellm as { baseUrl?: unknown } | undefined;
  const resolvedBaseUrl =
    overrides?.baseUrl ||
    (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "") ||
    LITELLM_BASE_URL;

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "litellm",
    api: "openai-completions",
    baseUrl: resolvedBaseUrl,
    defaultModel,
    defaultModelId: modelId,
  });
}

export function applyLitellmConfig(
  cfg: OpenClawConfig,
  overrides?: { baseUrl?: string; modelId?: string },
): OpenClawConfig {
  const modelId = overrides?.modelId || LITELLM_DEFAULT_MODEL_ID;
  const next = applyLitellmProviderConfig(cfg, overrides);
  return applyAgentDefaultModelPrimary(next, `litellm/${modelId}`);
}
