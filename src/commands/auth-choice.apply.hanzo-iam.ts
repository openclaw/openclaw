import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";

const HANZO_IAM_AUTHORIZE_ENDPOINT = "https://hanzo.id/login/oauth/authorize";
const HANZO_IAM_TOKEN_ENDPOINT = "https://hanzo.id/api/login/oauth/access_token";
const HANZO_CLIENT_ID = "hanzo-bot-client-id";
const HANZO_REDIRECT_URI = "http://127.0.0.1:1456/oauth-callback";
const HANZO_SCOPES = "openid profile email";
const HANZO_API_BASE_URL = "https://api.hanzo.ai/v1";

function buildHanzoAuthorizeUrl(state: string): string {
  const qs = new URLSearchParams({
    client_id: process.env.HANZO_CLIENT_ID?.trim() || HANZO_CLIENT_ID,
    redirect_uri: process.env.HANZO_OAUTH_REDIRECT_URI?.trim() || HANZO_REDIRECT_URI,
    response_type: "code",
    scope: HANZO_SCOPES,
    state,
  });
  return `${HANZO_IAM_AUTHORIZE_ENDPOINT}?${qs.toString()}`;
}

async function waitForLocalCallback(params: {
  redirectUri: string;
  expectedState: string;
  timeoutMs: number;
  onProgress?: (message: string) => void;
}): Promise<{ code: string; state: string }> {
  const redirectUrl = new URL(params.redirectUri);
  const hostname = redirectUrl.hostname || "127.0.0.1";
  const port = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : 80;
  const expectedPath = redirectUrl.pathname || "/";

  return await new Promise<{ code: string; state: string }>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", redirectUrl.origin);
        if (requestUrl.pathname !== expectedPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }

        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();

        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Missing code");
          return;
        }
        if (!state || state !== params.expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid state");
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          [
            "<!doctype html>",
            "<html><head><meta charset='utf-8' /></head>",
            "<body><h2>Hanzo login complete</h2>",
            "<p>You can close this window and return to Hanzo Bot.</p></body></html>",
          ].join(""),
        );
        if (timeout) {
          clearTimeout(timeout);
        }
        server.close();
        resolve({ code, state });
      } catch (err) {
        if (timeout) {
          clearTimeout(timeout);
        }
        server.close();
        reject(err);
      }
    });

    server.once("error", (err) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      server.close();
      reject(err);
    });
    server.listen(port, hostname, () => {
      params.onProgress?.(`Waiting for OAuth callback on ${redirectUrl.origin}${expectedPath}…`);
    });

    timeout = setTimeout(() => {
      try {
        server.close();
      } catch {}
      reject(new Error("OAuth callback timeout"));
    }, params.timeoutMs);
  });
}

async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}> {
  const clientId = process.env.HANZO_CLIENT_ID?.trim() || HANZO_CLIENT_ID;
  const redirectUri = process.env.HANZO_OAUTH_REDIRECT_URI?.trim() || HANZO_REDIRECT_URI;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(HANZO_IAM_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hanzo IAM token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in?: number;
  };
}

export async function applyAuthChoiceHanzoIam(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "hanzo-cloud") {
    return null;
  }

  let nextConfig = params.config;
  const isRemote = isRemoteEnvironment();
  const redirectUri = process.env.HANZO_OAUTH_REDIRECT_URI?.trim() || HANZO_REDIRECT_URI;

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
          "Browser will open for Hanzo authentication.",
          "Sign in with your Hanzo account to access all AI models.",
          "",
          "No account? One will be created automatically.",
        ].join("\n"),
    "Hanzo Cloud Login",
  );

  const spin = params.prompter.progress("Starting Hanzo OAuth flow…");
  try {
    const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter: params.prompter,
      runtime: params.runtime,
      spin,
      openUrl,
      localBrowserMessage: "Complete sign-in in browser…",
    });

    const state = randomBytes(16).toString("hex");
    const authorizeUrl = buildHanzoAuthorizeUrl(state);
    const timeoutMs = 3 * 60 * 1000;

    let codeAndState: { code: string; state: string };
    if (isRemote) {
      await onAuth({ url: authorizeUrl });
      spin.update("Waiting for redirect URL…");
      const input = await onPrompt({
        message: "Paste the redirect URL (or authorization code)",
        placeholder: `${redirectUri}?code=...&state=...`,
      });
      const inputStr = String(input).trim();
      let code: string;
      try {
        const parsed = new URL(inputStr);
        code = parsed.searchParams.get("code") ?? inputStr;
      } catch {
        code = inputStr;
      }
      codeAndState = { code, state };
    } else {
      const callback = waitForLocalCallback({
        redirectUri,
        expectedState: state,
        timeoutMs,
        onProgress: (msg) => spin.update(msg),
      });

      await onAuth({ url: authorizeUrl });
      codeAndState = await callback;
    }

    spin.update("Exchanging code for tokens…");
    const tokens = await exchangeCodeForTokens(codeAndState.code);

    spin.stop("Hanzo login complete");

    const creds = {
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? "",
      expires: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0,
      tokenType: tokens.token_type,
      createdAt: Date.now(),
    };

    await writeOAuthCredentials("hanzo-iam", creds, params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "hanzo-cloud:default",
      provider: "hanzo-iam",
      mode: "oauth",
    });

    // Set the access token as the API key for Hanzo Cloud
    process.env.HANZO_API_KEY = tokens.access_token;

    await params.prompter.note(
      [
        "Hanzo Cloud connected. You now have access to:",
        "  - Zen4 (flagship, pro, max, mini, coder, thinking, ultra)",
        "  - Zen3 (omni, vl, nano, embedding)",
        "  - Claude (Opus, Sonnet, Haiku) via unified billing",
        "  - GPT-5, Gemini, and 300+ more models",
        "",
        `API endpoint: ${HANZO_API_BASE_URL}`,
      ].join("\n"),
      "Connected",
    );
  } catch (err) {
    spin.stop("Hanzo login failed");
    params.runtime.error(String(err));
    await params.prompter.note(
      [
        "Trouble with Hanzo login?",
        "1. Make sure hanzo.id is reachable",
        "2. Try again or use an API key provider instead",
        "3. Visit https://hanzo.bot/docs for help",
      ].join("\n"),
      "Login help",
    );
  }
  return { config: nextConfig };
}
