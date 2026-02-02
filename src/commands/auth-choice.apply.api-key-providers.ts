import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import {
  applyAuthProfileConfig,
  applyLitellmConfig,
  applyLitellmProviderConfig,
  LITELLM_DEFAULT_MODEL_REF,
  applyPuterConfig,
  applyPuterProviderConfig,
  PUTER_DEFAULT_MODEL_REF,
  setLitellmApiKey,
  setPuterApiKey,
} from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import type { SecretInputMode } from "./onboard-types.js";

type ApiKeyProviderConfigApplier = (
  config: ApplyAuthChoiceParams["config"],
) => ApplyAuthChoiceParams["config"];

type ApplyProviderDefaultModel = (args: {
  defaultModel: string;
  applyDefaultConfig: ApiKeyProviderConfigApplier;
  applyProviderConfig: ApiKeyProviderConfigApplier;
  noteDefault?: string;
}) => Promise<void>;

type ApplyApiKeyProviderParams = {
  params: ApplyAuthChoiceParams;
  authChoice: string;
  config: ApplyAuthChoiceParams["config"];
  setConfig: (config: ApplyAuthChoiceParams["config"]) => void;
  getConfig: () => ApplyAuthChoiceParams["config"];
  normalizedTokenProvider?: string;
  requestedSecretInputMode?: SecretInputMode;
  applyProviderDefaultModel: ApplyProviderDefaultModel;
  getAgentModelOverride: () => string | undefined;
};

export async function applyLiteLlmApiKeyProvider({
  params,
  authChoice,
  config,
  setConfig,
  getConfig,
  normalizedTokenProvider,
  requestedSecretInputMode,
  applyProviderDefaultModel,
  getAgentModelOverride,
}: ApplyApiKeyProviderParams): Promise<ApplyAuthChoiceResult | null> {
  if (authChoice !== "litellm-api-key") {
    return null;
  }

  let nextConfig = config;
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const profileOrder = resolveAuthProfileOrder({ cfg: nextConfig, store, provider: "litellm" });
  const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
  const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
  let profileId = "litellm:default";
  let hasCredential = Boolean(existingProfileId && existingCred?.type === "api_key");
  if (hasCredential && existingProfileId) {
    profileId = existingProfileId;
  }

  if (!hasCredential) {
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: normalizedTokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["litellm"],
      provider: "litellm",
      envLabel: "LITELLM_API_KEY",
      promptMessage: "Enter LiteLLM API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setLitellmApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
      noteMessage:
        "LiteLLM provides a unified API to 100+ LLM providers.\nGet your API key from your LiteLLM proxy or https://litellm.ai\nDefault proxy runs on http://localhost:4000",
      noteTitle: "LiteLLM",
    });
    hasCredential = true;
  }

  if (hasCredential) {
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "litellm",
      mode: "api_key",
    });
  }
  setConfig(nextConfig);
  await applyProviderDefaultModel({
    defaultModel: LITELLM_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyLitellmConfig,
    applyProviderConfig: applyLitellmProviderConfig,
    noteDefault: LITELLM_DEFAULT_MODEL_REF,
  });
  return { config: getConfig(), agentModelOverride: getAgentModelOverride() };
}

export async function applyPuterApiKeyProvider({
  params,
  authChoice,
  config,
  setConfig,
  getConfig,
  normalizedTokenProvider,
  requestedSecretInputMode,
  applyProviderDefaultModel,
  getAgentModelOverride,
}: ApplyApiKeyProviderParams): Promise<ApplyAuthChoiceResult | null> {
  if (authChoice !== "puter-web" && authChoice !== "puter-api-key") {
    return null;
  }

  let nextConfig = config;
  if (authChoice === "puter-web") {
    await params.prompter.note(
      [
        "Puter web login opens your browser so you can copy an API key.",
        "After signing in, paste the key back here.",
      ].join("\n"),
      "Puter",
    );
    const opened = await openUrl("https://puter.com/?action=copyauth");
    if (!opened) {
      await params.prompter.note(
        "Open this URL manually: https://puter.com/?action=copyauth",
        "Puter",
      );
    }
  }

  await ensureApiKeyFromOptionEnvOrPrompt({
    token: params.opts?.token,
    tokenProvider: normalizedTokenProvider,
    secretInputMode: requestedSecretInputMode,
    config: nextConfig,
    expectedProviders: ["puter"],
    provider: "puter",
    envLabel: "PUTER_API_KEY",
    promptMessage: "Enter Puter API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) =>
      setPuterApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
  });

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "puter:default",
    provider: "puter",
    mode: "api_key",
  });
  setConfig(nextConfig);
  await applyProviderDefaultModel({
    defaultModel: PUTER_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyPuterConfig,
    applyProviderConfig: applyPuterProviderConfig,
    noteDefault: PUTER_DEFAULT_MODEL_REF,
  });
  return { config: getConfig(), agentModelOverride: getAgentModelOverride() };
}
