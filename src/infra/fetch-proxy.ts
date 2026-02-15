import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import type { OpenClawConfig } from "../config/config.js";

let originalDispatcher: Dispatcher | null = null;
let currentProxyUrl: string | null = null;

export type GlobalFetchProxyStatus = {
  /** Whether a proxy is currently active for global fetch(). */
  active: boolean;
  /** The active proxy URL (if active). */
  proxyUrl: string | null;
  /** Whether this call changed the global dispatcher. */
  changed: boolean;
  /**
   * Where the proxy URL came from.
   * - "config": `proxy` top-level key
   * - "legacy_discord": `channels.discord.proxy` (back-compat)
   * - "none": no proxy configured
   */
  source: "config" | "legacy_discord" | "none";
};

function resolveProxyUrl(cfg: OpenClawConfig | undefined): {
  url: string | null;
  source: GlobalFetchProxyStatus["source"];
} {
  const direct = cfg?.proxy?.trim();
  if (direct) {
    return { url: direct, source: "config" };
  }

  // Back-compat: older experiments used a Discord-only proxy key.
  const legacyDiscord = (cfg?.channels?.discord as { proxy?: string } | undefined)?.proxy?.trim();
  if (legacyDiscord) {
    return { url: legacyDiscord, source: "legacy_discord" };
  }

  return { url: null, source: "none" };
}

/**
 * Configure undici's global dispatcher so Node's global fetch() goes through a proxy.
 *
 * Call early during process startup (e.g. gateway command) so all subsystems and
 * third-party libraries that use global fetch are covered.
 */
export function setupGlobalFetchProxy(cfg: OpenClawConfig | undefined): GlobalFetchProxyStatus {
  const resolved = resolveProxyUrl(cfg);
  const proxyUrl = resolved.url;

  // No proxy configured: restore original dispatcher if we changed it.
  if (!proxyUrl) {
    if (originalDispatcher) {
      setGlobalDispatcher(originalDispatcher);
      originalDispatcher = null;
      currentProxyUrl = null;
      return { active: false, proxyUrl: null, changed: true, source: resolved.source };
    }
    return { active: false, proxyUrl: null, changed: false, source: resolved.source };
  }

  // Same proxy already configured.
  if (proxyUrl === currentProxyUrl) {
    return { active: true, proxyUrl, changed: false, source: resolved.source };
  }

  // Save original dispatcher on first proxy setup.
  if (!originalDispatcher) {
    originalDispatcher = getGlobalDispatcher();
  }

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  currentProxyUrl = proxyUrl;
  return { active: true, proxyUrl, changed: true, source: resolved.source };
}
