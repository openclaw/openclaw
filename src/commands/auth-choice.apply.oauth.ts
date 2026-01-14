import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { isRemoteEnvironment, loginAntigravityVpsAware } from "./antigravity-oauth.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { loginChutes } from "./chutes-oauth.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";

export async function applyAuthChoiceOAuth(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice === "chutes") {
    let nextConfig = params.config;
    const isRemote = isRemoteEnvironment();
    const redirectUri =
      process.env.CHUTES_OAUTH_REDIRECT_URI?.trim() || "http://127.0.0.1:1456/oauth-callback";
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
      const email = creds.email?.trim() || "default";
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

  if (params.authChoice === "antigravity") {
    let nextConfig = params.config;
    let agentModelOverride: string | undefined;
    const noteAgentModel = async (model: string) => {
      if (!params.agentId) return;
      await params.prompter.note(
        `Default model set to ${model} for agent "${params.agentId}".`,
        "Model configured",
      );
    };

    const isRemote = isRemoteEnvironment();
    await params.prompter.note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, copy the redirect URL and paste it back here.",
          ].join("\n")
        : [
            "Browser will open for Google authentication.",
            "Sign in with your Google account that has Antigravity access.",
            "The callback will be captured automatically on localhost:51121.",
          ].join("\n"),
      "Google Antigravity OAuth",
    );
    const spin = params.prompter.progress("Starting OAuth flow…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAntigravityVpsAware(
        async (url) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            params.runtime.log(`Open: ${url}`);
          }
        },
        (msg) => spin.update(msg),
      );
      spin.stop("Antigravity OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials("google-antigravity", oauthCreds, params.agentDir);
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: `google-antigravity:${oauthCreds.email ?? "default"}`,
          provider: "google-antigravity",
          mode: "oauth",
        });
        const modelKey = "google-antigravity/claude-opus-4-5-thinking";
        nextConfig = {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents?.defaults,
              models: {
                ...nextConfig.agents?.defaults?.models,
                [modelKey]: nextConfig.agents?.defaults?.models?.[modelKey] ?? {},
              },
            },
          },
        };
        if (params.setDefaultModel) {
          const existingModel = nextConfig.agents?.defaults?.model;
          nextConfig = {
            ...nextConfig,
            agents: {
              ...nextConfig.agents,
              defaults: {
                ...nextConfig.agents?.defaults,
                model: {
                  ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
                    ? {
                        fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
                      }
                    : undefined),
                  primary: modelKey,
                },
              },
            },
          };
          await params.prompter.note(`Default model set to ${modelKey}`, "Model configured");
        } else {
          agentModelOverride = modelKey;
          await noteAgentModel(modelKey);
        }
      }
    } catch (err) {
      spin.stop("Antigravity OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        "Trouble with OAuth? See https://docs.clawd.bot/start/faq",
        "OAuth help",
      );
    }
    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
