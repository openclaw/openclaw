// BAN compatibility: force native fetch to avoid grammY's node-fetch shim under Bun.
export function resolveTelegramFetch(proxyFetch?: typeof fetch): typeof fetch {
  const fetchImpl = proxyFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set telegram.proxy in config");
  }
  return fetchImpl;
}
