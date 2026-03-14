import * as dns from "node:dns";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveFetch } from "../infra/fetch.js";
import { hasEnvHttpProxyConfigured } from "../infra/net/proxy-env.js";
import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";
import { getProxyUrlFromFetch } from "./proxy.js";

const log = createSubsystemLogger("telegram/network");

const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: unknown;
};

type TelegramDispatcher = Agent | EnvHttpProxyAgent | ProxyAgent;

type TelegramDispatcherMode = "direct" | "env-proxy" | "explicit-proxy";

type TelegramDnsResultOrder = "ipv4first" | "verbatim";

type LookupCallback =
  | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void);

type LookupOptions = (dns.LookupOneOptions | dns.LookupAllOptions) & {
  order?: TelegramDnsResultOrder;
  verbatim?: boolean;
};

type LookupFunction = (
  hostname: string,
  options: number | dns.LookupOneOptions | dns.LookupAllOptions | undefined,
  callback: LookupCallback,
) => void;

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

function normalizeDnsResultOrder(value: string | null): TelegramDnsResultOrder | null {
  if (value === "ipv4first" || value === "verbatim") {
    return value;
  }
  return null;
}

function createDnsResultOrderLookup(
  order: TelegramDnsResultOrder | null,
): LookupFunction | undefined {
  if (!order) {
    return undefined;
  }
  const lookup = dns.lookup as unknown as (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ) => void;
  return (hostname, options, callback) => {
    const baseOptions: LookupOptions =
      typeof options === "number"
        ? { family: options }
        : options
          ? { ...(options as LookupOptions) }
          : {};
    const lookupOptions: LookupOptions = {
      ...baseOptions,
      order,
      // Keep `verbatim` for compatibility with Node runtimes that ignore `order`.
      verbatim: order === "verbatim",
    };
    lookup(hostname, lookupOptions, callback);
  };
}

function buildTelegramConnectOptions(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  forceIpv4: boolean;
}): {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  family?: number;
  lookup?: LookupFunction;
} | null {
  const connect: {
    autoSelectFamily?: boolean;
    autoSelectFamilyAttemptTimeout?: number;
    family?: number;
    lookup?: LookupFunction;
  } = {};

  if (params.forceIpv4) {
    connect.family = 4;
    connect.autoSelectFamily = false;
  } else if (typeof params.autoSelectFamily === "boolean") {
    connect.autoSelectFamily = params.autoSelectFamily;
    connect.autoSelectFamilyAttemptTimeout = TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS;
  }

  const lookup = createDnsResultOrderLookup(params.dnsResultOrder);
  if (lookup) {
    connect.lookup = lookup;
  }

  return Object.keys(connect).length > 0 ? connect : null;
}

function shouldBypassEnvProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  // We need this classification before dispatch to decide whether sticky IPv4 fallback
  // can safely arm. EnvHttpProxyAgent does not expose route decisions (proxy vs direct
  // NO_PROXY bypass), so we mirror undici's parsing/matching behavior for this host.
  // Match EnvHttpProxyAgent behavior (undici):
  // - lower-case no_proxy takes precedence over NO_PROXY
  // - entries split by comma or whitespace
  // - wildcard handling is exact-string "*" only
  // - leading "." and "*." are normalized the same way
  const noProxyValue = env.no_proxy ?? env.NO_PROXY ?? "";
  if (!noProxyValue) {
    return false;
  }
  if (noProxyValue === "*") {
    return true;
  }
  const targetHostname = TELEGRAM_API_HOSTNAME.toLowerCase();
  const targetPort = 443;
  const noProxyEntries = noProxyValue.split(/[,\s]/);
  for (let i = 0; i < noProxyEntries.length; i++) {
    const entry = noProxyEntries[i];
    if (!entry) {
      continue;
    }
    const parsed = entry.match(/^(.+):(\d+)$/);
    const entryHostname = (parsed ? parsed[1] : entry).replace(/^\*?\./, "").toLowerCase();
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== targetPort) {
      continue;
    }
    if (
      targetHostname === entryHostname ||
      targetHostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`
    ) {
      return true;
    }
  }
  return false;
}

function hasEnvHttpProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasEnvHttpProxyConfigured("https", env);
}

function resolveTelegramDispatcherPolicy(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  useEnvProxy: boolean;
  forceIpv4: boolean;
  proxyUrl?: string;
}): { policy: PinnedDispatcherPolicy; mode: TelegramDispatcherMode } {
  const connect = buildTelegramConnectOptions({
    autoSelectFamily: params.autoSelectFamily,
    dnsResultOrder: params.dnsResultOrder,
    forceIpv4: params.forceIpv4,
  });
  const explicitProxyUrl = params.proxyUrl?.trim();
  if (explicitProxyUrl) {
    return {
      policy: connect
        ? {
            mode: "explicit-proxy",
            proxyUrl: explicitProxyUrl,
            proxyTls: { ...connect },
          }
        : {
            mode: "explicit-proxy",
            proxyUrl: explicitProxyUrl,
          },
      mode: "explicit-proxy",
    };
  }
  if (params.useEnvProxy) {
    return {
      policy: {
        mode: "env-proxy",
        ...(connect ? { connect: { ...connect }, proxyTls: { ...connect } } : {}),
      },
      mode: "env-proxy",
    };
  }
  return {
    policy: {
      mode: "direct",
      ...(connect ? { connect: { ...connect } } : {}),
    },
    mode: "direct",
  };
}

function createTelegramDispatcher(policy: PinnedDispatcherPolicy): {
  dispatcher: TelegramDispatcher;
  mode: TelegramDispatcherMode;
  effectivePolicy: PinnedDispatcherPolicy;
} {
  if (policy.mode === "explicit-proxy") {
    const proxyOptions = policy.proxyTls
      ? ({
          uri: policy.proxyUrl,
          proxyTls: { ...policy.proxyTls },
        } satisfies ConstructorParameters<typeof ProxyAgent>[0])
      : policy.proxyUrl;
    try {
      return {
        dispatcher: new ProxyAgent(proxyOptions),
        mode: "explicit-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: err });
    }
  }

  if (policy.mode === "env-proxy") {
    const proxyOptions =
      policy.connect || policy.proxyTls
        ? ({
            ...(policy.connect ? { connect: { ...policy.connect } } : {}),
            // undici's EnvHttpProxyAgent passes `connect` only to the no-proxy Agent.
            // Real proxied HTTPS traffic reads transport settings from ProxyAgent.proxyTls.
            ...(policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}),
          } satisfies ConstructorParameters<typeof EnvHttpProxyAgent>[0])
        : undefined;
    try {
      return {
        dispatcher: new EnvHttpProxyAgent(proxyOptions),
        mode: "env-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      log.warn(
        `env proxy dispatcher init failed; falling back to direct dispatcher: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const directPolicy: PinnedDispatcherPolicy = {
        mode: "direct",
        ...(policy.connect ? { connect: { ...policy.connect } } : {}),
      };
      return {
        dispatcher: new Agent(
          directPolicy.connect
            ? ({
                connect: { ...directPolicy.connect },
              } satisfies ConstructorParameters<typeof Agent>[0])
            : undefined,
        ),
        mode: "direct",
        effectivePolicy: directPolicy,
      };
    }
  }

  return {
    dispatcher: new Agent(
      policy.connect
        ? ({
            connect: { ...policy.connect },
          } satisfies ConstructorParameters<typeof Agent>[0])
        : undefined,
    ),
    mode: "direct",
    effectivePolicy: policy,
  };
}

function withDispatcherIfMissing(
  init: RequestInit | undefined,
  dispatcher: TelegramDispatcher,
): RequestInitWithDispatcher {
  const withDispatcher = init as RequestInitWithDispatcher | undefined;
  if (withDispatcher?.dispatcher) {
    return init ?? {};
  }
  return init ? { ...init, dispatcher } : { dispatcher };
}

function resolveWrappedFetch(fetchImpl: typeof fetch): typeof fetch {
  return resolveFetch(fetchImpl) ?? fetchImpl;
}

function logResolverNetworkDecisions(params: {
  autoSelectDecision: ReturnType<typeof resolveTelegramAutoSelectFamilyDecision>;
  dnsDecision: ReturnType<typeof resolveTelegramDnsResultOrderDecision>;
}): void {
  if (params.autoSelectDecision.value !== null) {
    const sourceLabel = params.autoSelectDecision.source
      ? ` (${params.autoSelectDecision.source})`
      : "";
    log.info(`autoSelectFamily=${params.autoSelectDecision.value}${sourceLabel}`);
  }
  if (params.dnsDecision.value !== null) {
    const sourceLabel = params.dnsDecision.source ? ` (${params.dnsDecision.source})` : "";
    log.info(`dnsResultOrder=${params.dnsDecision.value}${sourceLabel}`);
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

function formatErrorCodes(err: unknown): string {
  const codes = [...collectErrorCodes(err)];
  return codes.length > 0 ? codes.join(",") : "none";
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

export function shouldRetryTelegramIpv4Fallback(err: unknown): boolean {
  return shouldRetryWithIpv4Fallback(err);
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export type TelegramTransport = {
  fetch: typeof fetch;
  sourceFetch: typeof fetch;
  pinnedDispatcherPolicy?: PinnedDispatcherPolicy;
  fallbackPinnedDispatcherPolicy?: PinnedDispatcherPolicy;
};

export function resolveTelegramTransport(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): TelegramTransport {
  const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({
    network: options?.network,
  });
  const dnsDecision = resolveTelegramDnsResultOrderDecision({
    network: options?.network,
  });
  logResolverNetworkDecisions({
    autoSelectDecision,
    dnsDecision,
  });

  const explicitProxyUrl = proxyFetch ? getProxyUrlFromFetch(proxyFetch) : undefined;
  const undiciSourceFetch = resolveWrappedFetch(undiciFetch as unknown as typeof fetch);
  const sourceFetch = explicitProxyUrl
    ? undiciSourceFetch
    : proxyFetch
      ? resolveWrappedFetch(proxyFetch)
      : undiciSourceFetch;
  const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
  // Preserve fully caller-owned custom fetch implementations.
  if (proxyFetch && !explicitProxyUrl) {
    return { fetch: sourceFetch, sourceFetch };
  }

  const useEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForTelegramApi();
  const defaultDispatcherResolution = resolveTelegramDispatcherPolicy({
    autoSelectFamily: autoSelectDecision.value,
    dnsResultOrder,
    useEnvProxy,
    forceIpv4: false,
    proxyUrl: explicitProxyUrl,
  });
  const defaultDispatcher = createTelegramDispatcher(defaultDispatcherResolution.policy);
  const shouldBypassEnvProxy = shouldBypassEnvProxyForTelegramApi();
  const allowStickyIpv4Fallback =
    defaultDispatcher.mode === "direct" ||
    (defaultDispatcher.mode === "env-proxy" && shouldBypassEnvProxy);
  const stickyShouldUseEnvProxy = defaultDispatcher.mode === "env-proxy";
  const fallbackPinnedDispatcherPolicy = allowStickyIpv4Fallback
    ? resolveTelegramDispatcherPolicy({
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
        useEnvProxy: stickyShouldUseEnvProxy,
        forceIpv4: true,
        proxyUrl: explicitProxyUrl,
      }).policy
    : undefined;

  let stickyIpv4FallbackEnabled = false;
  let stickyIpv4Dispatcher: TelegramDispatcher | null = null;
  const resolveStickyIpv4Dispatcher = () => {
    if (!stickyIpv4Dispatcher) {
      if (!fallbackPinnedDispatcherPolicy) {
        return defaultDispatcher.dispatcher;
      }
      stickyIpv4Dispatcher = createTelegramDispatcher(fallbackPinnedDispatcherPolicy).dispatcher;
    }
    return stickyIpv4Dispatcher;
  };

  const resolvedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const callerProvidedDispatcher = Boolean(
      (init as RequestInitWithDispatcher | undefined)?.dispatcher,
    );
    const initialInit = withDispatcherIfMissing(
      init,
      stickyIpv4FallbackEnabled ? resolveStickyIpv4Dispatcher() : defaultDispatcher.dispatcher,
    );
    try {
      return await sourceFetch(input, initialInit);
    } catch (err) {
      if (shouldRetryWithIpv4Fallback(err)) {
        // Preserve caller-owned dispatchers on retry.
        if (callerProvidedDispatcher) {
          return sourceFetch(input, init ?? {});
        }
        // Proxy routes should not arm sticky IPv4 mode; `family=4` would constrain
        // proxy-connect behavior instead of Telegram endpoint selection.
        if (!allowStickyIpv4Fallback) {
          throw err;
        }
        if (!stickyIpv4FallbackEnabled) {
          stickyIpv4FallbackEnabled = true;
          log.warn(
            `fetch fallback: enabling sticky IPv4-only dispatcher (codes=${formatErrorCodes(err)})`,
          );
        }
        return sourceFetch(input, withDispatcherIfMissing(init, resolveStickyIpv4Dispatcher()));
      }
      throw err;
    }
  }) as typeof fetch;

  return {
    fetch: resolvedFetch,
    sourceFetch,
    pinnedDispatcherPolicy: defaultDispatcher.effectivePolicy,
    fallbackPinnedDispatcherPolicy,
  };
}

export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch {
  return resolveTelegramTransport(proxyFetch, options).fetch;
}
