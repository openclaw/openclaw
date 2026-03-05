import { upsertAuthProfile } from "../agents/auth-profiles.js";
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

  return null;
}
