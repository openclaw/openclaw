import process from "node:process";
import { makeProxyFetch, resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";

export { makeProxyFetch } from "../infra/net/proxy-fetch.js";

export const TELEGRAM_PROXY_ENV = "OPENCLAW_TELEGRAM_PROXY";

/**
 * Resolve the Telegram proxy URL from config or environment.
 * Priority: config proxy > OPENCLAW_TELEGRAM_PROXY env var.
 */
export function resolveTelegramProxyUrl(configProxy?: string): string | undefined {
  const fromConfig = configProxy?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = process.env[TELEGRAM_PROXY_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return undefined;
}

/**
 * Resolve a proxy-aware fetch for Telegram API requests.
 * Priority:
 * 1. Config proxy URL (channels.telegram.proxy or OPENCLAW_TELEGRAM_PROXY)
 * 2. Standard HTTP_PROXY/HTTPS_PROXY env vars
 */
export function resolveTelegramProxyFetch(configProxy?: string): typeof fetch | undefined {
  const proxyUrl = resolveTelegramProxyUrl(configProxy);
  if (proxyUrl) {
    return makeProxyFetch(proxyUrl);
  }
  return resolveProxyFetchFromEnv();
}
