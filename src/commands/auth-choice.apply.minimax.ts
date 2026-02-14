import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
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
  const noteAgentModel = async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };
  if (params.authChoice === "minimax-portal") {
    // Let user choose between Global/CN endpoints
    const endpoint = await params.prompter.select({
      message: "Select MiniMax endpoint",
      options: [
        { value: "oauth", label: "Global", hint: "OAuth for international users" },
        { value: "oauth-cn", label: "CN", hint: "OAuth for users in China" },
      ],
    });

    return await applyAuthChoicePluginProvider(params, {
      authChoice: "minimax-portal",
      pluginId: "minimax-portal-auth",
      providerId: "minimax-portal",
      methodId: endpoint,
      label: "MiniMax",
    });
  }

  if (
    params.authChoice === "minimax-cloud" ||
    params.authChoice === "minimax-api" ||
    params.authChoice === "minimax-api-lightning"
  ) {
    const modelId =
      params.authChoice === "minimax-api-lightning" ? "MiniMax-M2.5-Lightning" : "MiniMax-M2.5";
    let hasCredential = false;
    const envKey = resolveEnvApiKey("minimax");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing MINIMAX_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setMinimaxApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter MiniMax API key",
        validate: validateApiKeyInput,
      });
      await setMinimaxApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    {
      const modelRef = `minimax/${modelId}`;
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: modelRef,
        applyDefaultConfig: (config) => applyMinimaxApiConfig(config, modelId),
        applyProviderConfig: (config) => applyMinimaxApiProviderConfig(config, modelId),
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (params.authChoice === "minimax-api-key-cn") {
    const modelId = "MiniMax-M2.5";
    let hasCredential = false;
    const envKey = resolveEnvApiKey("minimax");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing MINIMAX_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setMinimaxApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter MiniMax China API key",
        validate: validateApiKeyInput,
      });
      await setMinimaxApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    {
      const modelRef = `minimax/${modelId}`;
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: modelRef,
        applyDefaultConfig: applyMinimaxApiConfigCn,
        applyProviderConfig: applyMinimaxApiProviderConfigCn,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (params.authChoice === "minimax") {
    const applied = await applyDefaultModelChoice({
      config: nextConfig,
      setDefaultModel: params.setDefaultModel,
      defaultModel: "lmstudio/minimax-m2.1-gs32",
      applyDefaultConfig: applyMinimaxConfig,
      applyProviderConfig: applyMinimaxProviderConfig,
      noteAgentModel,
      prompter: params.prompter,
    });
    nextConfig = applied.config;
    agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
