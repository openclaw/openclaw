import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import {
  applyAuthProfileConfig,
  applyXaiConfig,
  applyXaiProviderConfig,
  setXaiApiKey,
  XAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";

export async function applyAuthChoiceXAI(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "xai-api-key") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.xaiApiKey,
    tokenProvider: "xai",
    secretInputMode: requestedSecretInputMode,
    config: nextConfig,
    expectedProviders: ["xai"],
    provider: "xai",
    envLabel: "XAI_API_KEY",
    promptMessage: "Enter xAI API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setXaiApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "xai:default",
    provider: "xai",
    mode: "api_key",
  });
  {
    const applied = await applyDefaultModelChoice({
      config: nextConfig,
      setDefaultModel: params.setDefaultModel,
      defaultModel: XAI_DEFAULT_MODEL_REF,
      applyDefaultConfig: applyXaiConfig,
      applyProviderConfig: applyXaiProviderConfig,
      noteDefault: XAI_DEFAULT_MODEL_REF,
      noteAgentModel,
      prompter: params.prompter,
    });
    nextConfig = applied.config;
    agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
  }

  return { config: nextConfig, agentModelOverride };
}
