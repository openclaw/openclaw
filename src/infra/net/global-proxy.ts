import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from "undici";

const ENV_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

let applied = false;

export function hasEnvProxy(): boolean {
  for (const key of ENV_PROXY_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }
  return false;
}

export type GlobalProxyOptions = {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  /** Explicit proxy URL; takes precedence over env vars when provided. */
  proxyUrl?: string;
};

/**
 * Install a global undici dispatcher that routes all outbound fetch() through
 * a proxy. When `proxyUrl` is provided it takes precedence; otherwise the
 * dispatcher reads HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars.
 *
 * Safe to call multiple times (idempotent). Returns true when the dispatcher
 * was installed (or was already installed from a prior call).
 */
export function installGlobalProxyDispatcher(options?: GlobalProxyOptions): boolean {
  const explicitUrl = options?.proxyUrl?.trim();
  if (!explicitUrl && !hasEnvProxy()) {
    return false;
  }

  const connectOpts =
    options?.autoSelectFamily !== undefined || options?.autoSelectFamilyAttemptTimeout !== undefined
      ? {
          connect: {
            ...(options.autoSelectFamily !== undefined
              ? { autoSelectFamily: options.autoSelectFamily }
              : {}),
            ...(options.autoSelectFamilyAttemptTimeout !== undefined
              ? { autoSelectFamilyAttemptTimeout: options.autoSelectFamilyAttemptTimeout }
              : {}),
          },
        }
      : {};

  // Explicit URL → ProxyAgent; env vars → EnvHttpProxyAgent.
  // ProxyAgent constructor throws on a malformed URI, so keep it inside the try.
  try {
    const agent = explicitUrl
      ? new ProxyAgent({ uri: explicitUrl, ...connectOpts })
      : new EnvHttpProxyAgent(connectOpts);
    setGlobalDispatcher(agent);
    applied = true;
    return true;
  } catch {
    return false;
  }
}

export function isGlobalProxyInstalled(): boolean {
  return applied;
}

export function resetGlobalProxyStateForTests(): void {
  applied = false;
}
