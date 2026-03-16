import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  normalizeSecretInputModeInput,
  ensureApiKeyFromOptionEnvOrPrompt,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";
import { applyAuthProfileConfig, setAnthropicApiKey } from "./onboard-auth.js";

const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";

export async function applyAuthChoiceAnthropic(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  if (
    params.authChoice === "setup-token" ||
    params.authChoice === "oauth" ||
    params.authChoice === "token"
  ) {
    return await applyAuthChoicePluginProvider(params, {
      authChoice: params.authChoice,
      pluginId: "anthropic",
      providerId: "anthropic",
      methodId: "setup-token",
      label: "Anthropic",
    });
  }

  if (params.authChoice === "apiKey") {
    if (params.opts?.tokenProvider && params.opts.tokenProvider !== "anthropic") {
      return null;
    }

    let nextConfig = params.config;
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.token,
      tokenProvider: params.opts?.tokenProvider ?? "anthropic",
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["anthropic"],
      provider: "anthropic",
      envLabel: "ANTHROPIC_API_KEY",
      promptMessage: "Enter Anthropic API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setAnthropicApiKey(apiKey, params.agentDir, { secretInputMode: mode }),
    });
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_ANTHROPIC_MODEL);
    }
    return { config: nextConfig };
  }

  return null;
}
