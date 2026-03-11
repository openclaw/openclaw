import { DASHSCOPE_DEFAULT_MODEL_REF } from "../agents/dashscope-models.js";
import { applyAuthProfileConfig } from "../plugins/provider-auth-helpers.js";
import { setDashscopeApiKey } from "../plugins/provider-auth-storage.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyPrimaryModel } from "./model-picker.js";

export async function applyAuthChoiceDashscope(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "dashscope-api-key") {
    return null;
  }

  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.dashscopeApiKey,
    tokenProvider: "dashscope",
    secretInputMode: requestedSecretInputMode,
    config: params.config,
    expectedProviders: ["dashscope"],
    provider: "dashscope",
    envLabel: "DASHSCOPE_API_KEY",
    promptMessage: "Enter Dashscope API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setDashscopeApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });
  const configWithAuth = applyAuthProfileConfig(params.config, {
    profileId: "dashscope:default",
    provider: "dashscope",
    mode: "api_key",
  });
  const configWithModel = applyPrimaryModel(configWithAuth, DASHSCOPE_DEFAULT_MODEL_REF);
  return {
    config: configWithModel,
    agentModelOverride: DASHSCOPE_DEFAULT_MODEL_REF,
  };
}
