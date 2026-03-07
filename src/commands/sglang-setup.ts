import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const SGLANG_DEFAULT_BASE_URL = "http://127.0.0.1:30000/v1";
export const SGLANG_DEFAULT_CONTEXT_WINDOW = 128000;
export const SGLANG_DEFAULT_MAX_TOKENS = 8192;
export const SGLANG_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export async function promptAndConfigureSglang(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const baseUrlRaw = await params.prompter.text({
    message: "SGLang base URL",
    initialValue: SGLANG_DEFAULT_BASE_URL,
    placeholder: SGLANG_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: "SGLang API key",
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: "SGLang model",
    placeholder: "meta-llama/Llama-3.1-8B-Instruct",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(apiKeyRaw ?? "").trim();
  const modelId = String(modelIdRaw ?? "").trim();
  const modelRef = `sglang/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "sglang:default",
    credential: { type: "api_key", provider: "sglang", key: apiKey },
    agentDir: params.agentDir,
  });

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        sglang: {
          baseUrl,
          api: "openai-completions",
          apiKey: "SGLANG_API_KEY",
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ["text"],
              cost: SGLANG_DEFAULT_COST,
              contextWindow: SGLANG_DEFAULT_CONTEXT_WINDOW,
              maxTokens: SGLANG_DEFAULT_MAX_TOKENS,
            },
          ],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}
