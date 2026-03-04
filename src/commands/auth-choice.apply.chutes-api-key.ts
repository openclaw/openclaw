import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { applyChutesConfig, applyChutesProviderConfig, setChutesApiKey } from "./onboard-auth.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";
import { CHUTES_DEFAULT_MODEL_REF } from "./onboard-auth.models.js";

export async function applyAuthChoiceChutesApiKey(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "chutes-api-key") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.token,
    tokenProvider: "chutes",
    secretInputMode: requestedSecretInputMode,
    config: nextConfig,
    expectedProviders: ["chutes"],
    provider: "chutes",
    envLabel: "CHUTES_API_KEY",
    promptMessage: "Enter Chutes API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setChutesApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "chutes:default",
    provider: "chutes",
    mode: "api_key",
  });

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: CHUTES_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyChutesConfig,
    applyProviderConfig: applyChutesProviderConfig,
    noteDefault: CHUTES_DEFAULT_MODEL_REF,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
