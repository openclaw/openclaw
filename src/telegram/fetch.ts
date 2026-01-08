// Ensure native fetch is used when available (Bun + Node 18+).
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
): typeof fetch | undefined {
  if (proxyFetch) return proxyFetch;
  const fetchImpl = globalThis.fetch;
  const isBun = "Bun" in globalThis || Boolean(process?.versions?.bun);
  if (!fetchImpl) {
    if (isBun) {
      throw new Error("fetch is not available; set telegram.proxy in config");
    }
    return undefined;
  }
  return fetchImpl;
}
