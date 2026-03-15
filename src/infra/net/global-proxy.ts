import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  hasProxyEnvConfigured,
  PROXY_ENV_KEYS,
  resolveAllProxyFallbackOptions,
} from "./proxy-env.js";

const log = createSubsystemLogger("net/global-proxy");

let applied = false;

/**
 * When HTTP_PROXY / HTTPS_PROXY / ALL_PROXY environment variables are set,
 * replace the default undici global dispatcher with an EnvHttpProxyAgent so
 * that **all** `globalThis.fetch` calls (including LLM inference via
 * `@mariozechner/pi-ai`) honour the proxy configuration.
 *
 * This is safe to call multiple times; only the first invocation takes effect.
 * If no proxy env var is detected the function is a no-op.
 */
export function applyGlobalProxyDispatcher(): void {
  if (applied) {
    return;
  }
  applied = true;

  if (!hasProxyEnvConfigured()) {
    return;
  }

  // If another module (e.g. Telegram) already installed a proxy-aware
  // dispatcher we leave it alone.
  const existing = getGlobalDispatcher();
  const ctorName = (existing as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName === "string" && ctorName.includes("ProxyAgent")) {
    log.info("proxy-aware global dispatcher already present, skipping");
    return;
  }

  try {
    // EnvHttpProxyAgent natively reads HTTP_PROXY / HTTPS_PROXY but ignores
    // ALL_PROXY. When only ALL_PROXY (or all_proxy) is set, pass its value
    // explicitly as httpProxy/httpsProxy so the agent still routes through it.
    const agentOptions = resolveAllProxyFallbackOptions() ?? {};

    setGlobalDispatcher(new EnvHttpProxyAgent(agentOptions));
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
