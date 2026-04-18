import { loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { formatErrorMessage } from "../infra/errors.js";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { OAuthPrompt } from "./provider-oauth-flow.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-codex-oauth-tls.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";
const openAICodexOAuthOriginator = "openclaw";
const localManualFallbackDelayMs = 15_000;

type OpenAICodexOAuthFailureCode = "callback_timeout" | "callback_validation_failed";

function waitForLocalManualFallbackOutcome(params: {
  fallbackDelayMs: number;
  waitForLoginToSettle: Promise<void>;
}): Promise<"prompt" | "settled"> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (outcome: "prompt" | "settled") => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeoutHandle);
      resolve(outcome);
    };
    const timeoutHandle = setTimeout(() => finish("prompt"), params.fallbackDelayMs);
    params.waitForLoginToSettle.then(
      () => finish("settled"),
      () => finish("settled"),
    );
  });
}

function createOpenAICodexOAuthError(
  code: OpenAICodexOAuthFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: OpenAICodexOAuthFailureCode } {
  const error = new Error(`OpenAI Codex OAuth failed (${code}): ${message}`, { cause });
  return Object.assign(error, { code });
}

function rewriteOpenAICodexOAuthError(error: unknown): Error {
  const message = formatErrorMessage(error);
  if (/state mismatch|missing authorization code/i.test(message)) {
    return createOpenAICodexOAuthError("callback_validation_failed", message, error);
  }
  return error instanceof Error ? error : new Error(message);
}

function createManualCodeInputHandler(params: {
  isRemote: boolean;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  runtime: RuntimeEnv;
  spin: ReturnType<WizardPrompter["progress"]>;
  waitForLoginToSettle: Promise<void>;
}): (() => Promise<string>) | undefined {
  if (params.isRemote) {
    return async () =>
      await params.onPrompt({
        message: manualInputPromptMessage,
      });
  }

  return async () => {
    const outcome = await waitForLocalManualFallbackOutcome({
      fallbackDelayMs: localManualFallbackDelayMs,
      waitForLoginToSettle: params.waitForLoginToSettle,
    });
    if (outcome === "settled") {
      // markLoginSettled() runs in loginOpenAICodexOAuth's finally block, so
      // reaching this branch means the outer login call has already completed.
      // Return a never-settling promise to suppress an unnecessary manual
      // prompt without feeding placeholder input back into the upstream flow.
      return await new Promise<string>(() => undefined);
    }
    params.spin.update("Browser callback did not finish. Paste the redirect URL to continue…");
    params.runtime.log(
      `OpenAI Codex OAuth callback did not arrive within ${localManualFallbackDelayMs}ms; switching to manual entry (callback_timeout).`,
    );
    return await params.onPrompt({
      message: manualInputPromptMessage,
    });
  };
}

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  ensureGlobalUndiciEnvProxyDispatcher();

  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    runtime.log(hint);
    await prompter.note(hint, "OAuth prerequisites");
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
  let markLoginSettled!: () => void;
  const waitForLoginToSettle = new Promise<void>((resolve) => {
    markLoginSettled = resolve;
  });
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
      originator: openAICodexOAuthOriginator,
      onManualCodeInput: createManualCodeInputHandler({
        isRemote,
        onPrompt,
        runtime,
        spin,
        waitForLoginToSettle,
      }),
      onProgress: (msg: string) => spin.update(msg),
    });
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    const rewrittenError = rewriteOpenAICodexOAuthError(err);
    runtime.error(String(rewrittenError));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw rewrittenError;
  } finally {
    markLoginSettled();
  }
}
