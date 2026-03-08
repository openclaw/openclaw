import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceAgentModelNoter,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import {
  applyAzureOpenAIConfig,
  applyAzureOpenAIProviderConfig,
  AZURE_OPENAI_DEFAULT_MODEL_ID,
  normalizeAzureOpenAIBaseUrl,
  normalizeAzureOpenAIModelId,
} from "./azure-openai-config.js";
import { applyAuthProfileConfig, setAzureOpenaiApiKey } from "./onboard-auth.js";

const AZURE_OPENAI_BASE_URL_PLACEHOLDER = "https://<resource>.openai.azure.com/openai/v1";

async function resolveAzureOpenAIBaseUrl(params: ApplyAuthChoiceParams): Promise<string> {
  const fromOpts = params.opts?.azureOpenaiBaseUrl?.trim();
  if (fromOpts) {
    return normalizeAzureOpenAIBaseUrl(fromOpts);
  }
  const value = await params.prompter.text({
    message: "Enter Azure OpenAI base URL",
    placeholder: AZURE_OPENAI_BASE_URL_PLACEHOLDER,
    validate: (candidate) => {
      try {
        normalizeAzureOpenAIBaseUrl(String(candidate ?? ""));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid Azure OpenAI base URL.";
      }
    },
  });
  return normalizeAzureOpenAIBaseUrl(String(value ?? ""));
}

async function resolveAzureOpenAIModelId(params: ApplyAuthChoiceParams): Promise<string> {
  const fromOpts = params.opts?.azureOpenaiModelId?.trim();
  if (fromOpts) {
    return normalizeAzureOpenAIModelId(fromOpts);
  }
  const value = await params.prompter.text({
    message: "Enter Azure OpenAI deployment/model ID",
    initialValue: AZURE_OPENAI_DEFAULT_MODEL_ID,
    validate: (candidate) => {
      try {
        normalizeAzureOpenAIModelId(String(candidate ?? ""));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid Azure OpenAI deployment/model ID.";
      }
    },
  });
  return normalizeAzureOpenAIModelId(String(value ?? ""));
}

export async function applyAuthChoiceAzureOpenAI(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "azure-openai-api-key") {
    return null;
  }

  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);

  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.azureOpenaiApiKey,
    tokenProvider: "azure-openai-responses",
    secretInputMode: requestedSecretInputMode,
    config: nextConfig,
    expectedProviders: ["azure-openai-responses"],
    provider: "azure-openai-responses",
    envLabel: "AZURE_OPENAI_API_KEY",
    promptMessage: "Enter Azure OpenAI API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setAzureOpenaiApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });

  const baseUrl = await resolveAzureOpenAIBaseUrl(params);
  const modelId = await resolveAzureOpenAIModelId(params);
  const apiVersion = params.opts?.azureOpenaiApiVersion?.trim() || undefined;
  const defaultModelRef = `azure-openai-responses/${modelId}`;

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "azure-openai-responses:default",
    provider: "azure-openai-responses",
    mode: "api_key",
  });

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: defaultModelRef,
    applyDefaultConfig: (cfg) => applyAzureOpenAIConfig(cfg, { baseUrl, modelId, apiVersion }),
    applyProviderConfig: (cfg) =>
      applyAzureOpenAIProviderConfig(cfg, { baseUrl, modelId, apiVersion }),
    noteDefault: defaultModelRef,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
