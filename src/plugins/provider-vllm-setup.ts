import {
  VLLM_DEFAULT_API_KEY_ENV_VAR,
  VLLM_DEFAULT_BASE_URL,
  VLLM_MODEL_PLACEHOLDER,
  VLLM_PROVIDER_LABEL,
} from "../agents/vllm-defaults.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyProviderDefaultModel,
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
} from "./provider-self-hosted-setup.js";

export { VLLM_DEFAULT_BASE_URL } from "../agents/vllm-defaults.js";
export const VLLM_DEFAULT_CONTEXT_WINDOW = SELF_HOSTED_DEFAULT_CONTEXT_WINDOW;
export const VLLM_DEFAULT_MAX_TOKENS = SELF_HOSTED_DEFAULT_MAX_TOKENS;
export const VLLM_DEFAULT_COST = SELF_HOSTED_DEFAULT_COST;

export async function promptAndConfigureVllm(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider({
    cfg: params.cfg,
    prompter: params.prompter,
    providerId: "vllm",
    providerLabel: VLLM_PROVIDER_LABEL,
    defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
    defaultApiKeyEnvVar: VLLM_DEFAULT_API_KEY_ENV_VAR,
    modelPlaceholder: VLLM_MODEL_PLACEHOLDER,
  });
  return {
    config: result.config,
    modelId: result.modelId,
    modelRef: result.modelRef,
  };
}

export { applyProviderDefaultModel as applyVllmDefaultModel };
