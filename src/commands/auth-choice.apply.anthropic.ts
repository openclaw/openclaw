import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "./auth-token.js";
import { applyAuthProfileConfig, setAnthropicApiKey } from "./onboard-auth.js";

export async function applyAuthChoiceAnthropic(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
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

    const tokenRaw = await params.prompter.text({
      message: "Paste Anthropic setup-token",
      validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
    });
    const token = String(tokenRaw).trim();

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
      },
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: namedProfileId,
      provider,
      mode: "token",
    });

    // Also save token to config file as fallback for gateway
    // Type cast is safe because normalizeProviders will fill in required fields
    const existingAnthropic = nextConfig.models?.providers?.anthropic ?? ({} as any);
    nextConfig = {
      ...nextConfig,
      models: {
        ...nextConfig.models,
        providers: {
          ...nextConfig.models?.providers,
          anthropic: {
            ...existingAnthropic,
            apiKey: token,
          },
        },
      },
    };

    return { config: nextConfig };
  }

  if (params.authChoice === "apiKey") {
    if (params.opts?.tokenProvider && params.opts.tokenProvider !== "anthropic") {
      return null;
    }

    let nextConfig = params.config;
    let hasCredential = false;
    const envKey = process.env.ANTHROPIC_API_KEY?.trim();

    let apiKey: string | undefined;

    if (params.opts?.token) {
      apiKey = normalizeApiKeyInput(params.opts.token);
      await setAnthropicApiKey(apiKey, params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential && envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing ANTHROPIC_API_KEY (env, ${formatApiKeyPreview(envKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        apiKey = envKey;
        await setAnthropicApiKey(apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Anthropic API key",
        validate: validateApiKeyInput,
      });
      apiKey = normalizeApiKeyInput(String(key));
      await setAnthropicApiKey(apiKey, params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });

    // Also save API key to config file as fallback for gateway
    if (apiKey) {
      // Type cast is safe because normalizeProviders will fill in required fields
      const existingAnthropic = nextConfig.models?.providers?.anthropic ?? ({} as any);
      nextConfig = {
        ...nextConfig,
        models: {
          ...nextConfig.models,
          providers: {
            ...nextConfig.models?.providers,
            anthropic: {
              ...existingAnthropic,
              apiKey,
            },
          },
        },
      };
    }

    return { config: nextConfig };
  }

  return null;
}
