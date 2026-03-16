import { resolveManifestProviderApiKeyChoice } from "../plugins/provider-auth-choices.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  createAuthChoiceDefaultModelApplierForMutableState,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
  normalizeTokenProviderInput,
} from "./auth-choice.apply-helpers.js";
import { applyLiteLlmApiKeyProvider } from "./auth-choice.apply.api-key-providers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";
import {
  applyAnthropicAzureProviderConfig,
  applyAuthProfileConfig,
  setAnthropicAzureApiKey,
} from "./onboard-auth.js";
import type { AuthChoice } from "./onboard-types.js";

const CORE_API_KEY_TOKEN_PROVIDER_AUTH_CHOICES: Partial<Record<string, AuthChoice>> = {
  litellm: "litellm-api-key",
  "anthropic-azure": "anthropic-azure-api-key",
};

export function normalizeApiKeyTokenProviderAuthChoice(params: {
  authChoice: AuthChoice;
  tokenProvider?: string;
  config?: ApplyAuthChoiceParams["config"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoice {
  if (params.authChoice !== "apiKey" || !params.tokenProvider) {
    return params.authChoice;
  }
  const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  if (!normalizedTokenProvider) {
    return params.authChoice;
  }
  return (
    (resolveManifestProviderApiKeyChoice({
      providerId: normalizedTokenProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })?.choiceId as AuthChoice | undefined) ??
    CORE_API_KEY_TOKEN_PROVIDER_AUTH_CHOICES[normalizedTokenProvider] ??
    params.authChoice
  );
}

export async function applyAuthChoiceApiProviders(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const applyProviderDefaultModel = createAuthChoiceDefaultModelApplierForMutableState(
    params,
    () => nextConfig,
    (config) => (nextConfig = config),
    () => agentModelOverride,
    (model) => (agentModelOverride = model),
  );

  const authChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: params.authChoice,
    tokenProvider: params.opts?.tokenProvider,
    config: params.config,
    env: process.env,
  });
  const normalizedTokenProvider = normalizeTokenProviderInput(params.opts?.tokenProvider);
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);

  const litellmResult = await applyLiteLlmApiKeyProvider({
    params,
    authChoice,
    config: nextConfig,
    setConfig: (config) => (nextConfig = config),
    getConfig: () => nextConfig,
    normalizedTokenProvider,
    requestedSecretInputMode,
    applyProviderDefaultModel,
    getAgentModelOverride: () => agentModelOverride,
  });
  if (litellmResult) {
    return litellmResult;
  }

  if (authChoice === "anthropic-azure-api-key") {
    const {
      ANTHROPIC_AZURE_MODEL_CHOICES,
      DEFAULT_ANTHROPIC_AZURE_MODEL_ID,
      normalizeAnthropicAzureBaseUrl,
      resolveAnthropicAzureBaseUrlFromEnv,
      resolveAnthropicAzureResourceName,
    } = await import("./anthropic-azure-utils.js");
    const baseUrlCandidate = params.opts?.anthropicAzureBaseUrl?.trim();
    const envBaseUrl = resolveAnthropicAzureBaseUrlFromEnv(process.env);

    const formatUnknownError = (error: unknown): string => {
      if (error instanceof Error) {
        return error.message;
      }
      if (typeof error === "string") {
        return error;
      }
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    };

    const resolveOrPromptBaseUrl = async (): Promise<string> => {
      if (baseUrlCandidate) {
        return normalizeAnthropicAzureBaseUrl(baseUrlCandidate);
      }
      if (envBaseUrl) {
        return envBaseUrl;
      }
      const baseUrlRaw = await params.prompter.text({
        message: "Azure Claude resource name or base URL",
        placeholder: "fabric-hub or https://fabric-hub.services.ai.azure.com/anthropic",
        validate: (value) => {
          try {
            normalizeAnthropicAzureBaseUrl(String(value ?? ""));
            return undefined;
          } catch (error) {
            return formatUnknownError(error);
          }
        },
      });
      return normalizeAnthropicAzureBaseUrl(String(baseUrlRaw ?? ""));
    };

    const normalizedBaseUrl = await resolveOrPromptBaseUrl();

    const resolveModelId = async (): Promise<string> => {
      const provided = params.opts?.anthropicAzureModelId?.trim();
      if (provided) {
        return provided;
      }
      if (typeof params.prompter.select === "function") {
        const options = [
          ...ANTHROPIC_AZURE_MODEL_CHOICES.map((choice) => ({
            value: choice.value,
            label: choice.label,
          })),
          { value: "__custom__", label: "Custom deployment ID" },
        ];
        const selection = await params.prompter.select<string>({
          message: "Default Azure Claude deployment",
          initialValue: DEFAULT_ANTHROPIC_AZURE_MODEL_ID,
          options,
        });
        if (selection === "__custom__") {
          const customId = await params.prompter.text({
            message: "Enter Azure Claude deployment ID",
            placeholder: "claude-sonnet-4-6",
          });
          const normalized = String(customId ?? "").trim();
          return normalized || DEFAULT_ANTHROPIC_AZURE_MODEL_ID;
        }
        return selection?.trim() || DEFAULT_ANTHROPIC_AZURE_MODEL_ID;
      }
      return DEFAULT_ANTHROPIC_AZURE_MODEL_ID;
    };

    const resolvedModelId = await resolveModelId();
    const resource = resolveAnthropicAzureResourceName(normalizedBaseUrl);

    const metadata = {
      baseUrl: normalizedBaseUrl,
      modelId: resolvedModelId,
      ...(resource ? { resource } : {}),
    };

    await ensureApiKeyFromOptionEnvOrPrompt({
      token: params.opts?.anthropicAzureApiKey,
      tokenProvider: params.opts?.tokenProvider ?? "anthropic-azure",
      secretInputMode: requestedSecretInputMode,
      config: nextConfig,
      expectedProviders: ["anthropic-azure"],
      provider: "anthropic-azure",
      envLabel: "ANTHROPIC_FOUNDRY_API_KEY / AZURE_CLAUDE_API_KEY",
      promptMessage: "Enter Azure Claude API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: params.prompter,
      setCredential: async (apiKey, mode) =>
        setAnthropicAzureApiKey(apiKey, params.agentDir, metadata, {
          secretInputMode: mode,
        }),
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic-azure:default",
      provider: "anthropic-azure",
      mode: "api_key",
    });

    nextConfig = applyAnthropicAzureProviderConfig(nextConfig, {
      baseUrl: normalizedBaseUrl,
      modelId: resolvedModelId,
    });

    const azureModelRef = `anthropic-azure/${resolvedModelId}`;
    await applyProviderDefaultModel({
      defaultModel: azureModelRef,
      applyDefaultConfig: (config) => applyAgentDefaultModelPrimary(config, azureModelRef),
      applyProviderConfig: (config) =>
        applyAnthropicAzureProviderConfig(config, {
          baseUrl: normalizedBaseUrl,
          modelId: resolvedModelId,
        }),
      noteDefault: azureModelRef,
    });

    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
