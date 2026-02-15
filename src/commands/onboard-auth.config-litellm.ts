import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "./onboard-auth.config-shared.js";
import { LITELLM_DEFAULT_MODEL_REF } from "./onboard-auth.credentials.js";

export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
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

export function applyLitellmProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[LITELLM_DEFAULT_MODEL_REF] = {
    ...models[LITELLM_DEFAULT_MODEL_REF],
    alias: models[LITELLM_DEFAULT_MODEL_REF]?.alias ?? "LiteLLM",
  };

  const defaultModel = buildLitellmModelDefinition();

  const existingProvider = cfg.models?.providers?.litellm as { baseUrl?: unknown } | undefined;
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
