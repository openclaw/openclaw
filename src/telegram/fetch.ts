import { setDefaultAutoSelectFamily } from "net";
import { resolveFetch } from "../infra/fetch.js";

// Workaround for Node.js 22 "Happy Eyeballs" (autoSelectFamily) bug
// that causes intermittent ETIMEDOUT errors when connecting to Telegram's
// dual-stack servers. Disabling autoSelectFamily forces sequential IPv4/IPv6
// attempts which works reliably.
// See: https://github.com/nodejs/node/issues/54359
try {
  setDefaultAutoSelectFamily(false);
} catch {
  // Ignore if not available (older Node versions)
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(proxyFetch?: typeof fetch): typeof fetch | undefined {
  if (proxyFetch) return resolveFetch(proxyFetch);
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return fetchImpl;
}
