// Bun compatibility: force native fetch under Bun; keep grammY defaults on Node.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
): typeof fetch | undefined {
  if (proxyFetch) return proxyFetch;
  const isBun = "Bun" in globalThis || Boolean(process?.versions?.bun);
  if (!isBun) return undefined;
  const fetchImpl = globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available; set telegram.proxy in config");
  }
  return fetchImpl;
}
