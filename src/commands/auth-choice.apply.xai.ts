import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
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
  const noteAgentModel = async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };

  let hasCredential = false;
  const optsKey = params.opts?.xaiApiKey?.trim();
  if (optsKey) {
    setXaiApiKey(normalizeApiKeyInput(optsKey), params.agentDir);
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
        setXaiApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) {
    const key = await params.prompter.text({
      message: "Enter xAI API key",
      validate: validateApiKeyInput,
    });
    setXaiApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
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
