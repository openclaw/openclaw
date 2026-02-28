import { RequestClient } from "@buape/carbon";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { loadConfig } from "../config/config.js";
import { createDiscordRetryRunner, type RetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { resolveDiscordAccount } from "./accounts.js";
import { normalizeDiscordToken } from "./token.js";

export type DiscordClientOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { explicit?: string; accountId: string; fallbackToken?: string }) {
  const explicit = normalizeDiscordToken(params.explicit, "channels.discord.token");
  if (explicit) {
    return explicit;
  }
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

// Cache ProxyAgent instances keyed by proxy URL to avoid creating new agents per call
const proxyAgentCache = new Map<string, ProxyAgent>();

/**
 * Gets or creates a ProxyAgent for the given proxy URL.
 */
function getOrCreateProxyAgent(proxyUrl: string): ProxyAgent {
  const cached = proxyAgentCache.get(proxyUrl);
  if (cached) {
    return cached;
  }
  const agent = new ProxyAgent(proxyUrl);
  proxyAgentCache.set(proxyUrl, agent);
  return agent;
}

/**
 * Creates a custom fetch function that routes requests through a proxy.
 * Uses undici's ProxyAgent for HTTP/HTTPS proxy support.
 * Reuses ProxyAgent instances by proxy URL for resource efficiency.
 *
 * @param proxyUrl - The proxy URL (e.g., "http://proxy.example.com:8080")
 * @returns A fetch function configured to use the proxy
 */
export function makeDiscordProxyFetch(proxyUrl: string): typeof fetch {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return fetch;
  }

  const agent = getOrCreateProxyAgent(proxy);
  return (input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
}

/**
 * Resolves the appropriate RequestClient for Discord REST API calls.
 * If a proxy is configured, injects a custom fetch function via Carbon's
 * requestOptions.fetch mechanism (based on Carbon PR #363).
 */
function resolveRest(token: string, proxyUrl?: string, rest?: RequestClient): RequestClient {
  if (rest) {
    return rest;
  }

  const proxy = proxyUrl?.trim();
  if (proxy) {
    const proxyFetch = makeDiscordProxyFetch(proxy);
    return new RequestClient(token, {
      fetch: proxyFetch,
    });
  }

  return new RequestClient(token);
}

export function createDiscordRestClient(opts: DiscordClientOpts, cfg = loadConfig()) {
  const account = resolveDiscordAccount({ cfg, accountId: opts.accountId });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.token,
  });
  const rest = resolveRest(token, account.config.proxy, opts.rest);
  return { token, rest, account };
}

export function createDiscordClient(
  opts: DiscordClientOpts,
  cfg = loadConfig(),
): { token: string; rest: RequestClient; request: RetryRunner } {
  const { token, rest, account } = createDiscordRestClient(opts, cfg);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts).rest;
}
