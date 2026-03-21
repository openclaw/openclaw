import { loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-codex-oauth-tls.js";

/**
 * Temporarily replace globalThis.fetch with a proxy-aware variant for the
 * duration of `fn`. The pi-ai library uses bare `fetch` internally and does
 * not accept a custom fetch parameter, so this is the only injection point.
 * The original fetch is restored in a finally block.
 */
async function withProxyFetch<T>(proxyFetch: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = proxyFetch;
  try {
    return await fn();
  } finally {
    // Only restore if we still own the slot (avoid clobbering a concurrent override)
    if (globalThis.fetch === proxyFetch) {
      globalThis.fetch = originalFetch;
    }
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
  const proxyFetch = resolveProxyFetchFromEnv();
  const preflight = await runOpenAIOAuthTlsPreflight({
    fetchImpl: proxyFetch,
  });
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

    const doLogin = () =>
      loginOpenAICodex({
        onAuth: baseOnAuth,
        onPrompt,
        onProgress: (msg: string) => spin.update(msg),
      });

    // pi-ai uses bare fetch internally; patch globalThis.fetch when a proxy is configured
    const creds = proxyFetch ? await withProxyFetch(proxyFetch, doLogin) : await doLogin();
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
