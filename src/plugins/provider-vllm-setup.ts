import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyProviderDefaultModel,
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
} from "./provider-self-hosted-setup.js";

// Keep setup-side defaults local so the provider-setup barrel does not recurse
// back through the generated plugin facade while vLLM's public surface loads.
export const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const VLLM_PROVIDER_LABEL = "vLLM";
export const VLLM_DEFAULT_API_KEY_ENV_VAR = "VLLM_API_KEY";
export const VLLM_MODEL_PLACEHOLDER = "meta-llama/Meta-Llama-3-8B-Instruct";
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
