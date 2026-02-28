import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceDefaultModelApplier,
  createAuthChoiceModelStateBridge,
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
  applyMinimaxConfig,
  applyMinimaxProviderConfig,
  setMinimaxApiKey,
} from "./onboard-auth.js";

export async function applyAuthChoiceMiniMax(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const applyProviderDefaultModel = createAuthChoiceDefaultModelApplier(
    params,
    createAuthChoiceModelStateBridge({
      getConfig: () => nextConfig,
      setConfig: (config) => (nextConfig = config),
      getAgentModelOverride: () => agentModelOverride,
      setAgentModelOverride: (model) => (agentModelOverride = model),
    }),
  );
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  const ensureMinimaxApiKey = async (opts: {
    profileId: string;
    promptMessage: string;
  }): Promise<void> => {
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: params.opts?.tokenProvider,
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["minimax", "minimax-cn"],
      provider: "minimax",
      envLabel: "MINIMAX_API_KEY",
      promptMessage: opts.promptMessage,
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setMinimaxApiKey(apiKey, params.agentDir, opts.profileId, { secretInputMode: mode }),
    });
  };
  const applyMinimaxApiVariant = async (opts: {
    profileId: string;
    provider: "minimax" | "minimax-cn";
    promptMessage: string;
    modelRefPrefix: "minimax" | "minimax-cn";
    modelId: string;
    applyDefaultConfig: (
      config: ApplyAuthChoiceParams["config"],
      modelId: string,
    ) => ApplyAuthChoiceParams["config"];
    applyProviderConfig: (
      config: ApplyAuthChoiceParams["config"],
      modelId: string,
    ) => ApplyAuthChoiceParams["config"];
  }): Promise<ApplyAuthChoiceResult> => {
    await ensureMinimaxApiKey({
      profileId: opts.profileId,
      promptMessage: opts.promptMessage,
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: opts.profileId,
      provider: opts.provider,
      mode: "api_key",
    });
    const modelRef = `${opts.modelRefPrefix}/${opts.modelId}`;
    await applyProviderDefaultModel({
      defaultModel: modelRef,
      applyDefaultConfig: (config) => opts.applyDefaultConfig(config, opts.modelId),
      applyProviderConfig: (config) => opts.applyProviderConfig(config, opts.modelId),
    });
    return { config: nextConfig, agentModelOverride };
  };
  if (params.authChoice === "minimax-portal") {
    return await applyAuthChoicePluginProvider(params, {
      authChoice: "minimax-portal",
      pluginId: "minimax-portal-auth",
      providerId: "minimax-portal",
      methodId: "oauth",
      label: "MiniMax (Global)",
    });
  }

  if (params.authChoice === "minimax-portal-cn") {
    return await applyAuthChoicePluginProvider(params, {
      authChoice: "minimax-portal-cn",
      pluginId: "minimax-portal-auth",
      providerId: "minimax-portal-cn",
      methodId: "oauth",
      label: "MiniMax (CN)",
    });
  }

  if (
    params.authChoice === "minimax-cloud" ||
    params.authChoice === "minimax-api" ||
    params.authChoice === "minimax-api-lightning"
  ) {
    return await applyMinimaxApiVariant({
      profileId: "minimax:default",
      provider: "minimax",
      promptMessage: "Enter MiniMax API key",
      modelRefPrefix: "minimax",
      modelId:
        params.authChoice === "minimax-api-lightning" ? "MiniMax-M2.5-Lightning" : "MiniMax-M2.5",
      applyDefaultConfig: applyMinimaxApiConfig,
      applyProviderConfig: applyMinimaxApiProviderConfig,
    });
  }

  if (params.authChoice === "minimax-api-key-cn") {
    return await applyMinimaxApiVariant({
      profileId: "minimax-cn:default",
      provider: "minimax-cn",
      promptMessage: "Enter MiniMax China API key",
      modelRefPrefix: "minimax-cn",
      modelId: "MiniMax-M2.5",
      applyDefaultConfig: applyMinimaxApiConfigCn,
      applyProviderConfig: applyMinimaxApiProviderConfigCn,
    });
  }

  if (params.authChoice === "minimax") {
    await applyProviderDefaultModel({
      defaultModel: "lmstudio/minimax-m2.1-gs32",
      applyDefaultConfig: applyMinimaxConfig,
      applyProviderConfig: applyMinimaxProviderConfig,
    });
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
