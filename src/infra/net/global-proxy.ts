import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  hasProxyEnvConfigured,
  PROXY_ENV_KEYS,
  resolveAllProxyFallbackOptions,
} from "./proxy-env.js";

const log = createSubsystemLogger("net/global-proxy");

/**
 * Loopback addresses that must always bypass the proxy.  OpenClaw's Ollama
 * (127.0.0.1:11434), browser control, canvas host, and other internal
 * services use loopback connections that should never be proxied.
 */
const DEFAULT_LOOPBACK_NO_PROXY = "localhost,127.0.0.1,[::1]";

/**
 * Merge loopback defaults into `process.env.no_proxy` so that **every**
 * future `new EnvHttpProxyAgent()` — including the one that
 * `ensureGlobalUndiciStreamTimeouts()` recreates on each embedded run —
 * inherits the loopback bypass without needing an explicit `noProxy` option.
 *
 * Returns the merged value for the caller's convenience.
 */
function ensureLoopbackNoProxy(): string {
  const existing = process.env.no_proxy?.trim() || process.env.NO_PROXY?.trim() || "";
  let merged: string;
  if (!existing) {
    merged = DEFAULT_LOOPBACK_NO_PROXY;
  } else if (existing === "*") {
    // NO_PROXY=* is the wildcard bypass — do not append anything or Node's
    // EnvHttpProxyAgent stops treating it as a universal bypass.
    merged = existing;
  } else {
    const entries = new Set(existing.split(",").map((e) => e.trim().toLowerCase()));
    const missing = DEFAULT_LOOPBACK_NO_PROXY.split(",").filter(
      (lb) => !entries.has(lb.toLowerCase()),
    );
    merged = missing.length > 0 ? `${existing},${missing.join(",")}` : existing;
  }
  process.env.no_proxy = merged;
  return merged;
}

/**
 * Success latch: set to `true` only after `EnvHttpProxyAgent` is
 * successfully installed (or a compatible dispatcher is already present).
 * A no-op early return (no proxy vars) or a constructor error leaves this
 * `false`, allowing a subsequent call to retry.
 *
 * Proxy env changes after a successful application require a full gateway
 * restart — the latch prevents redundant re-installation.
 */
let applied = false;

/**
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables are set,
 * replace the default undici global dispatcher with an EnvHttpProxyAgent so
 * that **all** `globalThis.fetch` calls (including LLM inference via
 * `@mariozechner/pi-ai`) honour the proxy configuration.
 *
 * Loopback addresses (localhost, 127.0.0.1, [::1]) are always excluded from
 * proxying to protect internal services like Ollama, browser control, and
 * canvas host.
 *
 * This is safe to call multiple times; once successfully applied, subsequent
 * calls are no-ops. If no proxy env var is detected or the constructor fails,
 * the latch stays unlocked so a future call can retry.
 */
export function applyGlobalProxyDispatcher(): void {
  if (applied) {
    return;
  }

  if (!hasProxyEnvConfigured()) {
    return;
  }

  // If another module (e.g. Telegram) already installed a proxy-aware
  // dispatcher we leave it alone.
  const existing = getGlobalDispatcher();
  const ctorName = (existing as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName === "string" && ctorName.includes("ProxyAgent")) {
    log.info("proxy-aware global dispatcher already present, skipping");
    applied = true;
    return;
  }

  try {
    const fallbackOptions = resolveAllProxyFallbackOptions();
    const agentOptions = {
      ...fallbackOptions,
      noProxy: ensureLoopbackNoProxy(),
    };

    // Warn when a SOCKS URL was rewritten — pure-SOCKS endpoints (e.g.
    // ssh -D tunnels) will fail at connect time with an opaque error.
    if (fallbackOptions) {
      const rawAllProxy = process.env.all_proxy?.trim() || process.env.ALL_PROXY?.trim() || "";
      if (rawAllProxy && fallbackOptions.httpsProxy && fallbackOptions.httpsProxy !== rawAllProxy) {
        log.warn(
          `ALL_PROXY "${rawAllProxy}" rewritten to "${fallbackOptions.httpsProxy}" for undici compatibility — if your proxy only supports SOCKS, LLM requests will fail`,
        );
      }
    }

    setGlobalDispatcher(new EnvHttpProxyAgent(agentOptions));
    applied = true;
    const active = PROXY_ENV_KEYS.find((k) => process.env[k]?.trim());
    log.info(`global undici dispatcher set to EnvHttpProxyAgent (via ${active})`);
  } catch (err) {
    log.warn(`failed to set global proxy dispatcher: ${String(err)}`);
  }
}

/** Reset state for tests. */
export function resetGlobalProxyStateForTests(): void {
  applied = false;
}
