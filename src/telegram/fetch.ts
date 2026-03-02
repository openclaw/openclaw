import * as dns from "node:dns";
import * as net from "node:net";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveFetch } from "../infra/fetch.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
let appliedDnsResultOrder: string | null = null;
let appliedGlobalDispatcherAutoSelectFamily: boolean | null = null;
const log = createSubsystemLogger("telegram/network");
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

function hasProxyEnvConfigured(): boolean {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function isProxyLikeDispatcher(dispatcher: unknown): boolean {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  return typeof ctorName === "string" && ctorName.includes("ProxyAgent");
}

const FALLBACK_RETRY_ERROR_CODES = [
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
] as const;

type Ipv4FallbackContext = {
  message: string;
  codes: Set<string>;
};

type Ipv4FallbackRule = {
  name: string;
  matches: (ctx: Ipv4FallbackContext) => boolean;
};

const IPV4_FALLBACK_RULES: readonly Ipv4FallbackRule[] = [
  {
    name: "fetch-failed-envelope",
    matches: ({ message }) => message.includes("fetch failed"),
  },
  {
    name: "known-network-code",
    matches: ({ codes }) => FALLBACK_RETRY_ERROR_CODES.some((code) => codes.has(code)),
  },
];

// Node 22 workaround: enable autoSelectFamily to allow IPv4 fallback on broken IPv6 networks.
// Many networks have IPv6 configured but not routed, causing "Network is unreachable" errors.
// See: https://github.com/nodejs/node/issues/54359
function applyTelegramNetworkWorkarounds(network?: TelegramNetworkConfig): void {
  // Apply autoSelectFamily workaround
  const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({ network });
  if (autoSelectDecision.value !== null && autoSelectDecision.value !== appliedAutoSelectFamily) {
    if (typeof net.setDefaultAutoSelectFamily === "function") {
      try {
        net.setDefaultAutoSelectFamily(autoSelectDecision.value);
        appliedAutoSelectFamily = autoSelectDecision.value;
        const label = autoSelectDecision.source ? ` (${autoSelectDecision.source})` : "";
        log.info(`autoSelectFamily=${autoSelectDecision.value}${label}`);
      } catch {
        // ignore if unsupported by the runtime
      }
    }
  }

  // Node 22's built-in globalThis.fetch uses undici's internal Agent whose
  // connect options are frozen at construction time. Calling
  // net.setDefaultAutoSelectFamily() after that agent is created has no
  // effect on it. Replace the global dispatcher with one that carries the
  // current autoSelectFamily setting so subsequent globalThis.fetch calls
  // inherit the same decision.
  // See: https://github.com/openclaw/openclaw/issues/25676
  if (
    autoSelectDecision.value !== null &&
    autoSelectDecision.value !== appliedGlobalDispatcherAutoSelectFamily
  ) {
    const existingGlobalDispatcher = getGlobalDispatcher();
    const shouldPreserveExistingProxy =
      isProxyLikeDispatcher(existingGlobalDispatcher) && !hasProxyEnvConfigured();
    if (!shouldPreserveExistingProxy) {
      try {
        setGlobalDispatcher(
          new EnvHttpProxyAgent({
            connect: {
              autoSelectFamily: autoSelectDecision.value,
              autoSelectFamilyAttemptTimeout: 300,
            },
          }),
        );
        appliedGlobalDispatcherAutoSelectFamily = autoSelectDecision.value;
        log.info(`global undici dispatcher autoSelectFamily=${autoSelectDecision.value}`);
      } catch {
        // ignore if setGlobalDispatcher is unavailable
      }
    }
  }

  // Apply DNS result order workaround for IPv4/IPv6 issues.
  // Some APIs (including Telegram) may fail with IPv6 on certain networks.
  // See: https://github.com/openclaw/openclaw/issues/5311
  const dnsDecision = resolveTelegramDnsResultOrderDecision({ network });
  if (dnsDecision.value !== null && dnsDecision.value !== appliedDnsResultOrder) {
    if (typeof dns.setDefaultResultOrder === "function") {
      try {
        dns.setDefaultResultOrder(dnsDecision.value as "ipv4first" | "verbatim");
        appliedDnsResultOrder = dnsDecision.value;
        const label = dnsDecision.source ? ` (${dnsDecision.source})` : "";
        log.info(`dnsResultOrder=${dnsDecision.value}${label}`);
      } catch {
        // ignore if unsupported by the runtime
      }
    }
  }
}

function collectErrorCodes(err: unknown): Set<string> {
  const codes = new Set<string>();
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code.trim()) {
        codes.add(code.trim().toUpperCase());
      }
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
    }
  }

  return codes;
}

function shouldRetryWithIpv4Fallback(err: unknown): boolean {
  const ctx: Ipv4FallbackContext = {
    message:
      err && typeof err === "object" && "message" in err ? String(err.message).toLowerCase() : "",
    codes: collectErrorCodes(err),
  };
  for (const rule of IPV4_FALLBACK_RULES) {
    if (!rule.matches(ctx)) {
      return false;
    }
  }
  return true;
}

function applyTelegramIpv4Fallback(): void {
  applyTelegramNetworkWorkarounds({
    autoSelectFamily: false,
    dnsResultOrder: "ipv4first",
  });
  log.warn("fetch fallback: forcing autoSelectFamily=false + dnsResultOrder=ipv4first");
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);
  const sourceFetch = proxyFetch ? resolveFetch(proxyFetch) : resolveFetch();
  if (!sourceFetch) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  // When Telegram media fetch hits dual-stack edge cases (ENETUNREACH/ETIMEDOUT),
  // switch to IPv4-safe network mode and retry once.
  if (proxyFetch) {
    return sourceFetch;
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await sourceFetch(input, init);
    } catch (err) {
      if (shouldRetryWithIpv4Fallback(err)) {
        applyTelegramIpv4Fallback();
        return sourceFetch(input, init);
      }
      throw err;
    }
  }) as typeof fetch;
}

export function resetTelegramFetchStateForTests(): void {
  appliedAutoSelectFamily = null;
  appliedDnsResultOrder = null;
  appliedGlobalDispatcherAutoSelectFamily = null;
}
