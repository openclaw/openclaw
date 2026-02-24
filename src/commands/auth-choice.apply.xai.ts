import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  normalizeSecretInputModeInput,
  resolveSecretInputModeForEnvSelection,
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

  let hasCredential = false;
  const optsKey = params.opts?.xaiApiKey?.trim();
  if (optsKey) {
    setXaiApiKey(normalizeApiKeyInput(optsKey), params.agentDir, {
      secretInputMode: requestedSecretInputMode,
    });
    hasCredential = true;
  }

  if (!hasCredential) {
    const envKey = resolveEnvApiKey("xai");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing XAI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        const mode = await resolveSecretInputModeForEnvSelection({
          prompter: params.prompter,
          explicitMode: requestedSecretInputMode,
        });
        setXaiApiKey(envKey.apiKey, params.agentDir, { secretInputMode: mode });
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) {
    const key = await params.prompter.text({
      message: "Enter xAI API key",
      validate: validateApiKeyInput,
    });
    setXaiApiKey(normalizeApiKeyInput(String(key)), params.agentDir, {
      secretInputMode: requestedSecretInputMode,
    });
  }

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
