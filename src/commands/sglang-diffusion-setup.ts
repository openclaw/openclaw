import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const SGLANG_DIFFUSION_DEFAULT_BASE_URL = "http://127.0.0.1:30000/v1";

export async function promptAndConfigureSglangDiffusion(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const baseUrlRaw = await params.prompter.text({
    message: "SGLang-Diffusion base URL",
    initialValue: SGLANG_DIFFUSION_DEFAULT_BASE_URL,
    placeholder: SGLANG_DIFFUSION_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: "SGLang-Diffusion API key",
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: "SGLang-Diffusion model",
    placeholder: "black-forest-labs/FLUX.1-dev",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(apiKeyRaw ?? "").trim();
  const modelId = String(modelIdRaw ?? "").trim();
  const modelRef = `sglang-diffusion/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "sglang-diffusion:default",
    credential: { type: "api_key", provider: "sglang-diffusion", key: apiKey },
    agentDir: params.agentDir,
  });

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        "sglang-diffusion": {
          baseUrl,
          api: "openai-completions",
          apiKey: "SGLANG_DIFFUSION_API_KEY", // pragma: allowlist secret
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 0,
              maxTokens: 0,
            },
          ],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}
