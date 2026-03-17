import { loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-codex-oauth-tls.js";

/** OpenAI token endpoint host — used for NO_PROXY checks. */
const TOKEN_HOST = "auth.openai.com";

/**
 * Returns true when `host` is excluded from proxying by `NO_PROXY` / `no_proxy`.
 * Supports bare hostnames, dotted-prefix matching (`.openai.com`), and the
 * wildcard `*` (proxy nothing).  Port and CIDR matching are intentionally
 * omitted — they are unusual for OAuth token endpoints.
 */
function isHostExcludedByNoProxy(host: string): boolean {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) return false;

  const entries = noProxy.split(",").map((e) => e.trim().toLowerCase());
  const lowerHost = host.toLowerCase();

  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") return true;
    if (lowerHost === entry) return true;
    // ".openai.com" matches "auth.openai.com"
    if (entry.startsWith(".") && lowerHost.endsWith(entry)) return true;
    // "openai.com" also matches "auth.openai.com" (curl convention)
    if (lowerHost === entry || lowerHost.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Node.js native fetch() ignores HTTP_PROXY / HTTPS_PROXY env vars.
 * This helper temporarily patches globalThis.fetch with a proxy-aware
 * implementation (via undici ProxyAgent) for the duration of `fn()`,
 * then restores the original fetch.  No-op when no proxy is configured,
 * when the target host is excluded via NO_PROXY, or when undici is
 * unavailable.
 */
async function withProxyFetch<T>(fn: () => Promise<T>): Promise<T> {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (!proxyUrl) return fn();
  if (isHostExcludedByNoProxy(TOKEN_HOST)) return fn();

  let restore: (() => void) | undefined;
  let agent: { close(): Promise<void> } | undefined;
  try {
    const { createRequire } = await import("node:module");
    const require_ = createRequire(import.meta.url);
    // undici is a transitive dependency of OpenClaw (via Node internals / direct dep)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require_("undici") as typeof import("undici");
    agent = new undici.ProxyAgent(proxyUrl);
    const origFetch = globalThis.fetch;
    const patchedFetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      undici.fetch(url as Parameters<typeof undici.fetch>[0], {
        ...(init as Parameters<typeof undici.fetch>[1]),
        dispatcher: agent as import("undici").Dispatcher,
      })) as typeof fetch;
    globalThis.fetch = patchedFetch;
    restore = () => {
      // Only restore if our patch is still in place (concurrency-safe)
      if (globalThis.fetch === patchedFetch) {
        globalThis.fetch = origFetch;
      }
    };
  } catch {
    // undici not available — proceed with unpatched fetch
  }

  try {
    return await fn();
  } finally {
    restore?.();
    try {
      await agent?.close();
    } catch {
      // ignore close errors
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

    const creds = await withProxyFetch(() =>
      loginOpenAICodex({
        onAuth: baseOnAuth,
        onPrompt,
        onProgress: (msg: string) => spin.update(msg),
      }),
    );
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
