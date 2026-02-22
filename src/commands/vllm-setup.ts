import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const VLLM_DEFAULT_CONTEXT_WINDOW = 128000;
export const VLLM_DEFAULT_MAX_TOKENS = 8192;
export const VLLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export async function promptAndConfigureVllm(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const baseUrlRaw = await params.prompter.text({
    message: "vLLM base URL",
    initialValue: VLLM_DEFAULT_BASE_URL,
    placeholder: VLLM_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: "vLLM API key",
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: "vLLM model",
    placeholder: "meta-llama/Meta-Llama-3-8B-Instruct",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(apiKeyRaw ?? "").trim();
  const modelId = String(modelIdRaw ?? "").trim();
  const modelRef = `vllm/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "vllm:default",
    credential: { type: "api_key", provider: "vllm", key: apiKey },
    agentDir: params.agentDir,
  });

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        vllm: {
          baseUrl,
          api: "openai-completions",
          apiKey: "VLLM_API_KEY",
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ["text"],
              cost: VLLM_DEFAULT_COST,
              contextWindow: VLLM_DEFAULT_CONTEXT_WINDOW,
              maxTokens: VLLM_DEFAULT_MAX_TOKENS,
            },
          ],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}
