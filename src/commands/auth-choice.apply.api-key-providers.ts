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
  let resolvedApiKey: string | undefined;

  if (!hasCredential) {
    // ensureApiKeyFromOptionEnvOrPrompt always returns the plaintext key,
    // even in --secret-input-mode=ref (the ref is passed to setCredential,
    // but the return value is the resolved plaintext).
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
  } else if (existingCred?.type === "api_key") {
    // Reusing a previously stored credential — try to read the plaintext key
    // so the model info probe can authenticate on secured proxies.
    const storedKey = (existingCred as { key?: unknown }).key;
    if (typeof storedKey === "string") {
      resolvedApiKey = storedKey;
    }
  }

  // Fall back to the LITELLM_API_KEY env var when no plaintext key is available
  // (e.g. ref-backed profiles where the stored key is a SecretRef object).
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
