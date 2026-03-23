import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyPrimaryModel } from "./model-picker.js";
import { applyAuthProfileConfig, setVolcengineApiKey } from "./onboard-auth.js";

/** Default model for Volcano Engine auth onboarding. */
export const VOLCENGINE_DEFAULT_MODEL = "volcengine-plan/ark-code-latest";

export async function applyAuthChoiceVolcengine(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "volcengine-api-key") {
    return null;
  }

  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.volcengineApiKey,
    tokenProvider: "volcengine",
    secretInputMode: requestedSecretInputMode,
    config: params.config,
    expectedProviders: ["volcengine"],
    provider: "volcengine",
    envLabel: "VOLCANO_ENGINE_API_KEY",
    promptMessage: "Enter Volcano Engine API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setVolcengineApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });
  const configWithAuth = applyAuthProfileConfig(params.config, {
    profileId: "volcengine:default",
    provider: "volcengine",
    mode: "api_key",
  });
  const configWithModel = applyPrimaryModel(configWithAuth, VOLCENGINE_DEFAULT_MODEL);
  return {
    config: configWithModel,
    agentModelOverride: VOLCENGINE_DEFAULT_MODEL,
  };
}
