import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import {
  buildTokenProfileId,
  tryParseClaudeCredentials,
  validateAnthropicRefreshToken,
  validateAnthropicSetupToken,
} from "./auth-token.js";
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
      [
        "Run `claude setup-token` in your terminal.",
        "Then paste the generated token below.",
        "",
        "Tip: For auto-refresh support, paste the FULL contents of",
        "~/.claude/.credentials.json instead (includes refresh token).",
      ].join("\n"),
      "Anthropic setup-token",
    );

    const tokenRaw = await params.prompter.text({
      message: "Paste Anthropic setup-token (or full .credentials.json)",
      validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
    });
    const tokenInput = String(tokenRaw).trim();

    const profileNameRaw = await params.prompter.text({
      message: "Token name (blank = default)",
      placeholder: "default",
    });
    const provider = "anthropic";
    const namedProfileId = buildTokenProfileId({
      provider,
      name: String(profileNameRaw ?? ""),
    });

    // Check if user pasted full JSON credentials (with refresh token)
    const parsedCreds = tryParseClaudeCredentials(tokenInput);

    if (parsedCreds && parsedCreds.refreshToken) {
      // Full JSON credentials with refresh token — store as type: "oauth"
      upsertAuthProfile({
        profileId: namedProfileId,
        agentDir: params.agentDir,
        credential: {
          type: "oauth",
          provider,
          access: parsedCreds.accessToken,
          refresh: parsedCreds.refreshToken,
          expires: parsedCreds.expiresAt ?? Date.now() + 3600 * 1000,
        },
      });

      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId: namedProfileId,
        provider,
        mode: "oauth",
      });
    } else {
      // Either plain access token or JSON with access token only.
      // Resolve the actual token string from parsed JSON or raw input.
      const accessToken = parsedCreds ? parsedCreds.accessToken : tokenInput;

      // Ask for optional refresh token
      const refreshRaw = await params.prompter.text({
        message: "Paste refresh token (sk-ant-ort01-...) for auto-refresh, or leave blank to skip",
        placeholder: "(optional)",
        validate: (value) => validateAnthropicRefreshToken(String(value ?? "")),
      });
      const refreshToken = String(refreshRaw ?? "").trim();

      if (refreshToken) {
        // Store as type: "oauth" with refresh token
        upsertAuthProfile({
          profileId: namedProfileId,
          agentDir: params.agentDir,
          credential: {
            type: "oauth",
            provider,
            access: accessToken,
            refresh: refreshToken,
            expires: Date.now() + 3600 * 1000, // assume 1h if not provided
          },
        });

        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: namedProfileId,
          provider,
          mode: "oauth",
        });
      } else {
        // No refresh token — fall back to static token (non-refreshable)
        upsertAuthProfile({
          profileId: namedProfileId,
          agentDir: params.agentDir,
          credential: {
            type: "token",
            provider,
            token: accessToken,
          },
        });

        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: namedProfileId,
          provider,
          mode: "token",
        });
      }
    }

    return { config: nextConfig };
  }

  if (params.authChoice === "apiKey") {
    if (params.opts?.tokenProvider && params.opts.tokenProvider !== "anthropic") {
      return null;
    }

    let nextConfig = params.config;
    let hasCredential = false;
    const envKey = process.env.ANTHROPIC_API_KEY?.trim();

    if (params.opts?.token) {
      await setAnthropicApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential && envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing ANTHROPIC_API_KEY (env, ${formatApiKeyPreview(envKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setAnthropicApiKey(envKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Anthropic API key",
        validate: validateApiKeyInput,
      });
      await setAnthropicApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
    return { config: nextConfig };
  }

  return null;
}
