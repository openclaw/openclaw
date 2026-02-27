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
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  setOpenrouterApiKey,
  OPENROUTER_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";

export async function applyAuthChoiceOpenRouter(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.token,
    tokenProvider: params.opts?.tokenProvider,
    secretInputMode: requestedSecretInputMode,
    config: nextConfig,
    expectedProviders: ["openrouter"],
    provider: "openrouter",
    envLabel: "OPENROUTER_API_KEY",
    promptMessage: "Enter OpenRouter API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setOpenrouterApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });

  // OpenRouter API key onboarding always writes `openrouter:default` credentials.
  // Keep config pointer in sync even if legacy oauth/token profiles exist.
  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "openrouter:default",
    provider: "openrouter",
    mode: "api_key",
  });

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyOpenrouterConfig,
    applyProviderConfig: applyOpenrouterProviderConfig,
    noteDefault: OPENROUTER_DEFAULT_MODEL_REF,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
