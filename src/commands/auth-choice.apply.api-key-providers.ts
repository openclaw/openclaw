import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { applyAuthProfileConfig } from "../plugins/provider-auth-helpers.js";
import { LITELLM_DEFAULT_MODEL_REF, setLitellmApiKey } from "../plugins/provider-auth-storage.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import {
  applyLitellmConfig,
  applyLitellmProviderConfig,
  fetchLitellmModelInfo,
  LITELLM_BASE_URL,
  LITELLM_DEFAULT_MODEL_ID,
} from "./onboard-auth.config-litellm.js";
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

  // Track the resolved plaintext API key for the model info probe.
  // ensureApiKeyFromOptionEnvOrPrompt always returns plaintext even in ref mode.
  let resolvedApiKey: string | undefined;

  if (!hasCredential) {
    resolvedApiKey = await ensureApiKeyFromOptionEnvOrPrompt({
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

  // Fall back to the LITELLM_API_KEY env var when reusing an existing credential.
  if (!resolvedApiKey) {
    resolvedApiKey = process.env.LITELLM_API_KEY ?? undefined;
  }

  if (hasCredential) {
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "litellm",
      mode: "api_key",
    });
  }
  setConfig(nextConfig);

  // Determine the LiteLLM base URL from a previously persisted config, if any,
  // or fall back to the default localhost address. This fetch happens before
  // applyProviderDefaultModel writes the new config.
  const existingProvider = nextConfig.models?.providers?.litellm as
    | { baseUrl?: unknown }
    | undefined;
  const baseUrl =
    typeof existingProvider?.baseUrl === "string" && existingProvider.baseUrl.trim()
      ? existingProvider.baseUrl.trim()
      : LITELLM_BASE_URL;

  // Probe the proxy for actual model capabilities (context window, max tokens)
  // so the config reflects the real model limits instead of the 128k default.
  const modelInfo = await fetchLitellmModelInfo(baseUrl, LITELLM_DEFAULT_MODEL_ID, resolvedApiKey);

  await applyProviderDefaultModel({
    defaultModel: LITELLM_DEFAULT_MODEL_REF,
    applyDefaultConfig: (cfg) => applyLitellmConfig(cfg, modelInfo),
    applyProviderConfig: (cfg) => applyLitellmProviderConfig(cfg, modelInfo),
    noteDefault: LITELLM_DEFAULT_MODEL_REF,
  });
  return { config: getConfig(), agentModelOverride: getAgentModelOverride() };
}
