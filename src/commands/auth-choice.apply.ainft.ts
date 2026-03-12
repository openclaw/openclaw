import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
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
  applyAinftConfig,
  applyAinftProviderConfig,
  setAinftApiKey,
  AINFT_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";

export async function applyAuthChoiceAinft(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);

  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const profileOrder = resolveAuthProfileOrder({
    cfg: nextConfig,
    store,
    provider: "ainft",
  });
  const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
  const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
  let profileId = "ainft:default";
  let mode: "api_key" | "oauth" | "token" = "api_key";
  let hasCredential = false;

  if (existingProfileId && existingCred?.type) {
    profileId = existingProfileId;
    mode =
      existingCred.type === "oauth" ? "oauth" : existingCred.type === "token" ? "token" : "api_key";
    hasCredential = true;
  }

  if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "ainft") {
    await setAinftApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir, {
      secretInputMode: requestedSecretInputMode,
    });
    hasCredential = true;
  }

  if (!hasCredential) {
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: params.opts?.tokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["ainft"],
      provider: "ainft",
      envLabel: "AINFT_API_KEY",
      promptMessage: "Enter AINFT API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setAinftApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    });
    hasCredential = true;
  }

  if (hasCredential) {
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "ainft",
      mode,
    });
  }

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: AINFT_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyAinftConfig,
    applyProviderConfig: applyAinftProviderConfig,
    noteDefault: AINFT_DEFAULT_MODEL_REF,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
