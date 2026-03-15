import { upsertAuthProfile } from "../agents/auth-profiles.js";
import {
  ANTHROPIC_AZURE_MODEL_CHOICES,
  DEFAULT_ANTHROPIC_AZURE_MODEL_ID,
  normalizeAnthropicAzureBaseUrl,
  resolveAnthropicAzureBaseUrlFromEnv,
  resolveAnthropicAzureResourceName,
} from "./anthropic-azure-utils.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";
import {
  normalizeSecretInputModeInput,
  ensureApiKeyFromOptionEnvOrPrompt,
  promptSecretRefForOnboarding,
  resolveSecretInputModeForEnvSelection,
} from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "./auth-token.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";
import {
  applyAnthropicAzureProviderConfig,
  applyAuthProfileConfig,
  setAnthropicApiKey,
  setAnthropicAzureApiKey,
} from "./onboard-auth.js";

const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";

function formatUnknownError(error: unknown): string {
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
}

export async function applyAuthChoiceAnthropic(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const requestedSecretInputMode = normalizeSecretInputModeInput(params.opts?.secretInputMode);
  if (
    params.authChoice === "setup-token" ||
    params.authChoice === "oauth" ||
    params.authChoice === "token"
  ) {
    let nextConfig = params.config;
    await params.prompter.note(
      ["Run `claude setup-token` in your terminal.", "Then paste the generated token below."].join(
        "\n",
      ),
      "Anthropic setup-token",
    );

    const selectedMode = await resolveSecretInputModeForEnvSelection({
      prompter: params.prompter,
      explicitMode: requestedSecretInputMode,
      copy: {
        modeMessage: "How do you want to provide this setup token?",
        plaintextLabel: "Paste setup token now",
        plaintextHint: "Stores the token directly in the auth profile",
      },
    });
    let token = "";
    let tokenRef: { source: "env" | "file" | "exec"; provider: string; id: string } | undefined;
    if (selectedMode === "ref") {
      const resolved = await promptSecretRefForOnboarding({
        provider: "anthropic-setup-token",
        config: params.config,
        prompter: params.prompter,
        preferredEnvVar: "ANTHROPIC_SETUP_TOKEN",
        copy: {
          sourceMessage: "Where is this Anthropic setup token stored?",
          envVarPlaceholder: "ANTHROPIC_SETUP_TOKEN",
        },
      });
      token = resolved.resolvedValue.trim();
      tokenRef = resolved.ref;
    } else {
      const tokenRaw = await params.prompter.text({
        message: "Paste Anthropic setup-token",
        validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
      });
      token = String(tokenRaw ?? "").trim();
    }
    const tokenValidationError = validateAnthropicSetupToken(token);
    if (tokenValidationError) {
      throw new Error(tokenValidationError);
    }

    const profileNameRaw = await params.prompter.text({
      message: "Token name (blank = default)",
      placeholder: "default",
    });
    const provider = "anthropic";
    const namedProfileId = buildTokenProfileId({
      provider,
      name: String(profileNameRaw ?? ""),
    });

    upsertAuthProfile({
      profileId: namedProfileId,
      agentDir: params.agentDir,
      credential: {
        type: "token",
        provider,
        token,
        ...(tokenRef ? { tokenRef } : {}),
      },
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: namedProfileId,
      provider,
      mode: "token",
    });
    if (params.setDefaultModel) {
      nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_ANTHROPIC_MODEL);
    }
    return { config: nextConfig };
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

  if (params.authChoice === "anthropic-azure-api-key") {
    let nextConfig = params.config;
    const baseUrlCandidate = params.opts?.anthropicAzureBaseUrl?.trim();
    const envBaseUrl = resolveAnthropicAzureBaseUrlFromEnv(process.env);

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

    if (params.setDefaultModel) {
      nextConfig = applyAgentDefaultModelPrimary(nextConfig, `anthropic-azure/${resolvedModelId}`);
    }

    return { config: nextConfig };
  }

  return null;
}
