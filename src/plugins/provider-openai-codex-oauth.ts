import { loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import { isErrno } from "../infra/errors.js";
import { tryListenOnPort } from "../infra/ports-probe.js";
import { describePortOwner } from "../infra/ports.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-codex-oauth-tls.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const OPENAI_CODEX_CALLBACK_PORT = 1455;

/** Non-null return means the port is occupied; `owner` is the process name when available. */
async function detectOpenAICodexCallbackPortConflict(): Promise<{ owner?: string } | null> {
  try {
    await tryListenOnPort({
      port: OPENAI_CODEX_CALLBACK_PORT,
      host: "127.0.0.1",
      exclusive: true,
    });
    return null;
  } catch (err) {
    if (!isErrno(err) || err.code !== "EADDRINUSE") {
      return null;
    }
    const owner = await describePortOwner(OPENAI_CODEX_CALLBACK_PORT);
    return { owner: owner ?? undefined };
  }
}

function buildOpenAICodexCallbackPortConflictNote(conflict: { owner?: string }): string {
  return [
    `Detected another local process already listening on localhost:${OPENAI_CODEX_CALLBACK_PORT}.`,
    "OpenAI Codex browser callback will not complete automatically in this state.",
    "Finish sign-in in the browser, then paste the full redirect URL back here.",
    ...(conflict.owner ? ["", "Port listener details:", conflict.owner] : []),
  ].join("\n");
}

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  // Ensure env-based proxy dispatcher is active before any outbound fetch calls,
  // including the TLS preflight check.
  ensureGlobalUndiciEnvProxyDispatcher();

  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    runtime.error(hint);
    await prompter.note(hint, "OAuth prerequisites");
    throw new Error(preflight.message);
  }

  const callbackPortConflict = isRemote ? null : await detectOpenAICodexCallbackPortConflict();

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
        ].join("\n")
      : callbackPortConflict !== null
        ? "Browser will open for OpenAI authentication."
        : [
            "Browser will open for OpenAI authentication.",
            "If the callback doesn't auto-complete, paste the redirect URL.",
            "OpenAI OAuth uses localhost:1455 for the callback.",
          ].join("\n"),
    "OpenAI Codex OAuth",
  );
  if (callbackPortConflict !== null) {
    await prompter.note(
      buildOpenAICodexCallbackPortConflictNote(callbackPortConflict),
      "OpenAI Codex OAuth",
    );
  }

  const spin = prompter.progress("Starting OAuth flow…");
  try {
    const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
      manualPromptMessage: manualInputPromptMessage,
    });

    const creds = await loginOpenAICodex({
      onAuth: baseOnAuth,
      onPrompt,
      onProgress: (msg: string) => spin.update(msg),
      onManualCodeInput:
        isRemote || callbackPortConflict !== null
          ? async () =>
              await onPrompt({
                message: manualInputPromptMessage,
              })
          : undefined,
    });
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
