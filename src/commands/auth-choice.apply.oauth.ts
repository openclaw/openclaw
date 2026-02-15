import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { loginChutes } from "./chutes-oauth.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";

/**
 * Validates OAuth redirect URI to prevent open redirect attacks (CWE-601).
 * Only allows localhost/127.0.0.1 on the expected port for local flows.
 */
function validateOAuthRedirectUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) {
    return "http://127.0.0.1:1456/oauth-callback";
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Don't echo the full untrusted URI to avoid leaking sensitive data in logs
    throw new Error("Invalid OAuth redirect URI: failed to parse URL");
  }

  // Only allow localhost/127.0.0.1 for local OAuth flows
  const allowedHosts = new Set(["127.0.0.1", "localhost"]);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(
      `Invalid OAuth redirect hostname: ${parsed.hostname}. ` +
        "Only localhost and 127.0.0.1 are allowed for security.",
    );
  }

  // Enforce expected port for local flows - port must be explicitly 1456
  // When URL omits port, parsed.port is "" which would default to 80/443
  const expectedPort = "1456";
  if (parsed.port !== expectedPort) {
    throw new Error(`Invalid OAuth redirect port. Expected ${expectedPort}.`);
  }

  // Must use http for localhost (not https)
  if (parsed.protocol !== "http:") {
    throw new Error("OAuth redirect URI must use http: protocol for localhost.");
  }

  return trimmed;
}

export async function applyAuthChoiceOAuth(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice === "chutes") {
    let nextConfig = params.config;
    const isRemote = isRemoteEnvironment();
    const redirectUri = validateOAuthRedirectUri(process.env.CHUTES_OAUTH_REDIRECT_URI || "");
    const scopes = process.env.CHUTES_OAUTH_SCOPES?.trim() || "openid profile chutes:invoke";
    const clientId =
      process.env.CHUTES_CLIENT_ID?.trim() ||
      String(
        await params.prompter.text({
          message: "Enter Chutes OAuth client id",
          placeholder: "cid_xxx",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    const clientSecret = process.env.CHUTES_CLIENT_SECRET?.trim() || undefined;

    await params.prompter.note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, paste the redirect URL back here.",
            "",
            `Redirect URI: ${redirectUri}`,
          ].join("\n")
        : [
            "Browser will open for Chutes authentication.",
            "If the callback doesn't auto-complete, paste the redirect URL.",
            "",
            `Redirect URI: ${redirectUri}`,
          ].join("\n"),
      "Chutes OAuth",
    );

    const spin = params.prompter.progress("Starting OAuth flow…");
    try {
      const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
        isRemote,
        prompter: params.prompter,
        runtime: params.runtime,
        spin,
        openUrl,
        localBrowserMessage: "Complete sign-in in browser…",
      });

      const creds = await loginChutes({
        app: {
          clientId,
          clientSecret,
          redirectUri,
          scopes: scopes.split(/\s+/).filter(Boolean),
        },
        manual: isRemote,
        onAuth,
        onPrompt,
        onProgress: (msg) => spin.update(msg),
      });

      spin.stop("Chutes OAuth complete");
      const email =
        typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default";
      const profileId = `chutes:${email}`;

      await writeOAuthCredentials("chutes", creds, params.agentDir);
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "chutes",
        mode: "oauth",
      });
    } catch (err) {
      spin.stop("Chutes OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        [
          "Trouble with OAuth?",
          "Verify CHUTES_CLIENT_ID (and CHUTES_CLIENT_SECRET if required).",
          `Verify the OAuth app redirect URI includes: ${redirectUri}`,
          "Chutes docs: https://chutes.ai/docs/sign-in-with-chutes/overview",
        ].join("\n"),
        "OAuth help",
      );
    }
    return { config: nextConfig };
  }

  return null;
}

// Export for testing
export const _test = {
  validateOAuthRedirectUri,
};
