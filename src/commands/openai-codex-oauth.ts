import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginOpenAICodex } from "@mariozechner/pi-ai";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./oauth-tls-preflight.js";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_RESPONSES_WRITE_SCOPE = "api.responses.write";
const OPENAI_REQUIRED_OAUTH_SCOPES = [
  OPENAI_RESPONSES_WRITE_SCOPE,
  "model.request",
  "api.model.read",
] as const;

function augmentOpenAIOAuthScopes(authUrl: string): string {
  try {
    const parsed = new URL(authUrl);
    const scopeParam = parsed.searchParams.get("scope");
    if (!scopeParam) {
      return authUrl;
    }
    const scopes = scopeParam
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (scopes.length === 0) {
      return authUrl;
    }
    const seen = new Set(scopes.map((scope) => scope.toLowerCase()));
    let changed = false;
    for (const requiredScope of OPENAI_REQUIRED_OAUTH_SCOPES) {
      const normalized = requiredScope.toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }
      scopes.push(requiredScope);
      seen.add(normalized);
      changed = true;
    }
    if (!changed) {
      return authUrl;
    }
    parsed.searchParams.set("scope", scopes.join(" "));
    return parsed.toString();
  } catch {
    return authUrl;
  }
}

function extractResponsesScopeErrorMessage(status: number, bodyText: string): string | null {
  if (status !== 401) {
    return null;
  }
  const normalized = bodyText.toLowerCase();
  if (
    normalized.includes("missing scope") &&
    normalized.includes(OPENAI_RESPONSES_WRITE_SCOPE.toLowerCase())
  ) {
    return bodyText.trim() || `Missing scopes: ${OPENAI_RESPONSES_WRITE_SCOPE}`;
  }
  return null;
}

async function detectMissingResponsesWriteScope(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const bodyText = await response.text();
    return extractResponsesScopeErrorMessage(response.status, bodyText);
  } catch {
    // Best effort only: network/TLS issues should not block successful OAuth completion.
    return null;
  }
}

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;
  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    runtime.error(hint);
    await prompter.note(hint, "OAuth prerequisites");
    throw new Error(preflight.message);
  }

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback.",
        ].join("\n"),
    "OpenAI Codex OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow…");
  try {
    const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
    });
    const onAuth = async (event: { url: string }) => {
      await baseOnAuth({
        ...event,
        url: augmentOpenAIOAuthScopes(event.url),
      });
    };

    const creds = await loginOpenAICodex({
      onAuth,
      onPrompt,
      onProgress: (msg) => spin.update(msg),
    });
    if (creds?.access) {
      const scopeError = await detectMissingResponsesWriteScope(creds.access);
      if (scopeError) {
        throw new Error(
          [
            `OpenAI OAuth token is missing required scope: ${OPENAI_RESPONSES_WRITE_SCOPE}.`,
            `Provider response: ${scopeError}`,
            "Re-authenticate with OpenAI Codex OAuth or use OPENAI_API_KEY with openai/* models.",
          ].join(" "),
        );
      }
    }
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
