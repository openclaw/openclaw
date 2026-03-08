import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginOpenAICodex } from "@mariozechner/pi-ai";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./oauth-tls-preflight.js";

const OPENAI_PROFILE_CLAIM_PATH = "https://api.openai.com/profile";

function extractEmailFromAccessToken(token: string | undefined): string | undefined {
  if (typeof token !== "string" || !token.trim()) {
    return undefined;
  }

  try {
    const [, payload] = token.split(".", 3);
    if (!payload) {
      return undefined;
    }
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as {
      [OPENAI_PROFILE_CLAIM_PATH]?: { email?: string };
    };
    const email = parsed?.[OPENAI_PROFILE_CLAIM_PATH]?.email?.trim();
    return email || undefined;
  } catch {
    return undefined;
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

    const creds = await loginOpenAICodex({
      onAuth: baseOnAuth,
      onPrompt,
      onProgress: (msg) => spin.update(msg),
    });
    spin.stop("OpenAI OAuth complete");
    if (!creds) {
      return null;
    }
    return {
      ...creds,
      ...(typeof creds.email === "string" && creds.email.trim()
        ? {}
        : {
            email: extractEmailFromAccessToken(
              typeof creds.access === "string" ? creds.access : undefined,
            ),
          }),
    };
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
