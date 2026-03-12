import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128000;
export const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
export const SELF_HOSTED_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function applyProviderDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: modelRef,
        },
      },
    },
  };
}

export async function promptAndConfigureOpenAICompatibleSelfHostedProvider(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): Promise<{
  config: OpenClawConfig;
  credential: AuthProfileCredential;
  modelId: string;
  modelRef: string;
  profileId: string;
}> {
  const baseUrlRaw = await params.prompter.text({
    message: `${params.providerLabel} base URL`,
    initialValue: params.defaultBaseUrl,
    placeholder: params.defaultBaseUrl,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: `${params.providerLabel} API key`,
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: `${params.providerLabel} model`,
    placeholder: params.modelPlaceholder,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(apiKeyRaw ?? "").trim();
  const modelId = String(modelIdRaw ?? "").trim();
  const modelRef = `${params.providerId}/${modelId}`;
  const profileId = `${params.providerId}:default`;
  const credential: AuthProfileCredential = {
    type: "api_key",
    provider: params.providerId,
    key: apiKey,
  };

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        [params.providerId]: {
          baseUrl,
          api: "openai-completions",
          apiKey: params.defaultApiKeyEnvVar,
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: params.reasoning ?? false,
              input: params.input ?? ["text"],
              cost: SELF_HOSTED_DEFAULT_COST,
              contextWindow: params.contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
              maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
            },
          ],
        },
      },
    },
  };

  return {
    config: nextConfig,
    credential,
    modelId,
    modelRef,
    profileId,
  };
}
