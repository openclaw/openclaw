import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { createAuthChoiceAgentModelNoter } from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import {
  applyAuthProfileConfig,
  applyFalOpenrouterConfig,
  applyFalOpenrouterProviderConfig,
  FAL_OPENROUTER_DEFAULT_MODEL_REF,
  setFalOpenrouterApiKey,
} from "./onboard-auth.js";

export async function applyAuthChoiceFalOpenRouter(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);

  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const profileOrder = resolveAuthProfileOrder({
    cfg: nextConfig,
    store,
    provider: "fal-openrouter",
  });
  const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
  const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
  let profileId = "fal-openrouter:default";
  let hasCredential = false;

  if (existingProfileId && existingCred?.type === "api_key") {
    profileId = existingProfileId;
    hasCredential = true;
  }

  if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "fal-openrouter") {
    await setFalOpenrouterApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
    hasCredential = true;
  }

  if (!hasCredential) {
    const envKey = resolveEnvApiKey("fal-openrouter");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing FAL_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setFalOpenrouterApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) {
    await params.prompter.note(
      [
        "Fal OpenRouter gives you access to LLMs via a single FAL_API_KEY.",
        "Get your API key at: https://fal.ai/dashboard/keys",
      ].join("\n"),
      "Fal OpenRouter",
    );
    const key = await params.prompter.text({
      message: "Enter Fal API key (FAL_API_KEY)",
      validate: validateApiKeyInput,
    });
    await setFalOpenrouterApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
    hasCredential = true;
  }

  if (hasCredential) {
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "fal-openrouter",
      mode: "api_key",
    });
  }

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: FAL_OPENROUTER_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyFalOpenrouterConfig,
    applyProviderConfig: applyFalOpenrouterProviderConfig,
    noteDefault: FAL_OPENROUTER_DEFAULT_MODEL_REF,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
