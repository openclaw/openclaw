import * as dns from "node:dns";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveFetch } from "../infra/fetch.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";
import { getProxyUrlFromFetch } from "./proxy.js";

const log = createSubsystemLogger("telegram/network");

const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: unknown;
};

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

function createTelegramDispatcher(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  useEnvProxy: boolean;
  forceIpv4: boolean;
  proxyUrl?: string;
}): Agent | EnvHttpProxyAgent | ProxyAgent {
  const connect = buildTelegramConnectOptions({
    autoSelectFamily: params.autoSelectFamily,
    dnsResultOrder: params.dnsResultOrder,
    forceIpv4: params.forceIpv4,
  });
  const explicitProxyUrl = params.proxyUrl?.trim();
  if (explicitProxyUrl) {
    const proxyOptions = connect
      ? ({
          uri: explicitProxyUrl,
          connect,
        } satisfies ConstructorParameters<typeof ProxyAgent>[0])
      : explicitProxyUrl;
    try {
      return new ProxyAgent(proxyOptions);
    } catch (err) {
      log.warn(
        `proxy dispatcher init failed; falling back to direct dispatcher: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (params.useEnvProxy) {
    const proxyOptions = connect
      ? ({
          connect,
        } satisfies ConstructorParameters<typeof EnvHttpProxyAgent>[0])
      : undefined;
    try {
      return new EnvHttpProxyAgent(proxyOptions);
    } catch (err) {
      log.warn(
        `env proxy dispatcher init failed; falling back to direct dispatcher: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const agentOptions = connect
    ? ({
        connect,
      } satisfies ConstructorParameters<typeof Agent>[0])
    : undefined;
  return new Agent(agentOptions);
}

function withDispatcherIfMissing(
  init: RequestInit | undefined,
  dispatcher: Agent | EnvHttpProxyAgent | ProxyAgent,
): RequestInitWithDispatcher {
  const withDispatcher = init as RequestInitWithDispatcher | undefined;
  if (withDispatcher?.dispatcher) {
    return init ?? {};
  }
  return init ? { ...init, dispatcher } : { dispatcher };
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

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
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
  const sourceFetch = explicitProxyUrl
    ? resolveFetch(undiciFetch as unknown as typeof fetch)
    : proxyFetch
      ? resolveFetch(proxyFetch)
      : resolveFetch(undiciFetch as unknown as typeof fetch);
  if (!sourceFetch) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }

  // Preserve fully caller-owned custom fetch implementations.
  // OpenClaw proxy fetches are metadata-tagged and continue into resolver-scoped policy.
  if (proxyFetch && !explicitProxyUrl) {
    return sourceFetch;
  }

  const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
  const useEnvProxy = !explicitProxyUrl && hasProxyEnvConfigured();
  const defaultDispatcher = createTelegramDispatcher({
    autoSelectFamily: autoSelectDecision.value,
    dnsResultOrder,
    useEnvProxy,
    forceIpv4: false,
    proxyUrl: explicitProxyUrl,
  });

  let stickyIpv4FallbackEnabled = false;
  let stickyIpv4Dispatcher: Agent | EnvHttpProxyAgent | ProxyAgent | null = null;
  const resolveStickyIpv4Dispatcher = () => {
    if (!stickyIpv4Dispatcher) {
      stickyIpv4Dispatcher = createTelegramDispatcher({
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
        useEnvProxy,
        forceIpv4: true,
        proxyUrl: explicitProxyUrl,
      });
    }
    return stickyIpv4Dispatcher;
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const callerProvidedDispatcher = Boolean(
      (init as RequestInitWithDispatcher | undefined)?.dispatcher,
    );
    const initialInit = withDispatcherIfMissing(
      init,
      stickyIpv4FallbackEnabled ? resolveStickyIpv4Dispatcher() : defaultDispatcher,
    );
    try {
      return await sourceFetch(input, initialInit);
    } catch (err) {
      if (shouldRetryWithIpv4Fallback(err)) {
        if (!callerProvidedDispatcher && !stickyIpv4FallbackEnabled) {
          stickyIpv4FallbackEnabled = true;
          log.warn(
            `fetch fallback: enabling sticky IPv4-only dispatcher (codes=${formatErrorCodes(err)})`,
          );
        }
        return sourceFetch(
          input,
          withDispatcherIfMissing(
            init,
            callerProvidedDispatcher ? defaultDispatcher : resolveStickyIpv4Dispatcher(),
          ),
        );
      }
      throw err;
    }
  }) as typeof fetch;
}
