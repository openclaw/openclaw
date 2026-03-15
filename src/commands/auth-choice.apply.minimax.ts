import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceDefaultModelApplierForMutableState,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";
import {
  applyAuthProfileConfig,
  applyMinimaxApiConfig,
  applyMinimaxApiConfigCn,
  applyMinimaxApiProviderConfig,
  applyMinimaxApiProviderConfigCn,
  setMinimaxApiKey,
} from "./onboard-auth.js";

export async function applyAuthChoiceMiniMax(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  // OAuth paths — delegate to plugin, no API key needed
  if (params.authChoice === "minimax-global-oauth") {
    return await applyAuthChoicePluginProvider(params, {
      authChoice: "minimax-global-oauth",
      pluginId: "minimax-portal-auth",
      providerId: "minimax-portal",
      methodId: "oauth",
      label: "MiniMax",
    });
  }

  if (params.authChoice === "minimax-cn-oauth") {
    return await applyAuthChoicePluginProvider(params, {
      authChoice: "minimax-cn-oauth",
      pluginId: "minimax-portal-auth",
      providerId: "minimax-portal",
      methodId: "oauth-cn",
      label: "MiniMax CN",
    });
  }

  // API key paths
  if (params.authChoice === "minimax-global-api" || params.authChoice === "minimax-cn-api") {
    const isCn = params.authChoice === "minimax-cn-api";
    const profileId = isCn ? "minimax:cn" : "minimax:global";
    const keyLink = isCn
      ? "https://platform.minimaxi.com/user-center/basic-information/interface-key"
      : "https://platform.minimax.io/user-center/basic-information/interface-key";
    const promptMessage = `Enter MiniMax ${isCn ? "CN " : ""}API key (sk-api- or sk-cp-)\n${keyLink}`;

    let nextConfig = params.config;
    let agentModelOverride: string | undefined;
    const applyProviderDefaultModel = createAuthChoiceDefaultModelApplierForMutableState(
      params,
      () => nextConfig,
      (config) => (nextConfig = config),
      () => agentModelOverride,
      (model) => (agentModelOverride = model),
    );
    const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);

    // Warn when both Global and CN share the same `minimax` provider entry — configuring one
    // overwrites the other's baseUrl. Only show when the other profile is already present.
    const otherProfileId = isCn ? "minimax:global" : "minimax:cn";
    const hasOtherProfile = Boolean(nextConfig.auth?.profiles?.[otherProfileId]);
    const noteMessage = hasOtherProfile
      ? `Note: Global and CN both use the "minimax" provider entry. Saving this key will overwrite the existing ${isCn ? "Global" : "CN"} endpoint (${otherProfileId}).`
      : undefined;

    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: params.opts?.tokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      // Accept "minimax-cn" as a legacy tokenProvider alias for the CN path.
      expectedProviders: isCn ? ["minimax", "minimax-cn"] : ["minimax"],
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      promptMessage,
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      noteMessage,
      setCredential: async (apiKey, mode) =>
        setMinimaxApiKey(apiKey, params.agentDir, profileId, { secretInputMode: mode }),
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "minimax",
      mode: "api_key",
    });

    await applyProviderDefaultModel({
      defaultModel: "minimax/MiniMax-M2.5",
      applyDefaultConfig: (config) =>
        isCn ? applyMinimaxApiConfigCn(config) : applyMinimaxApiConfig(config),
      applyProviderConfig: (config) =>
        isCn ? applyMinimaxApiProviderConfigCn(config) : applyMinimaxApiProviderConfig(config),
    });

    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
