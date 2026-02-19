import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import {
  applyAuthProfileConfig,
  applyEdgeeConfig,
  applyEdgeeProviderConfig,
  setEdgeeApiKey,
  EDGEE_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";

export async function applyAuthChoiceEdgee(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
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

  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const profileOrder = resolveAuthProfileOrder({
    cfg: nextConfig,
    store,
    provider: "edgee",
  });
  const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
  const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
  let profileId = "edgee:default";
  let hasCredential = false;

  if (existingProfileId && existingCred?.type === "api_key") {
    profileId = existingProfileId;
    hasCredential = true;
  }

  if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "edgee") {
    await setEdgeeApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
    hasCredential = true;
  }

  if (!hasCredential) {
    await params.prompter.note(
      [
        "Edgee is an AI Gateway with 200+ models and automatic token compression.",
        "Get your API key at: https://app.edgee.ai",
        "Base URL: https://api.edgee.ai/v1 (OpenAI-compatible)",
      ].join("\n"),
      "Edgee",
    );
  }

  if (!hasCredential) {
    const envKey = resolveEnvApiKey("edgee");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing EDGEE_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setEdgeeApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) {
    const key = await params.prompter.text({
      message: "Enter Edgee API key",
      validate: validateApiKeyInput,
    });
    await setEdgeeApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
    hasCredential = true;
  }

  if (hasCredential) {
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "edgee",
      mode: "api_key",
    });
  }

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: EDGEE_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyEdgeeConfig,
    applyProviderConfig: applyEdgeeProviderConfig,
    noteDefault: EDGEE_DEFAULT_MODEL_REF,
    noteAgentModel,
    prompter: params.prompter,
  });
  nextConfig = applied.config;
  agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

  return { config: nextConfig, agentModelOverride };
}
