import { resolveFetch } from "../infra/fetch.js";

// Bun-only: force native fetch to avoid grammY's Node shim under Bun.
export function resolveTelegramFetch(proxyFetch?: typeof fetch): typeof fetch | undefined {
  if (proxyFetch) return resolveFetch(proxyFetch);
  const isBun = "Bun" in globalThis || Boolean(process?.versions?.bun);
  if (!isBun) return undefined;
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return fetchImpl;
}
