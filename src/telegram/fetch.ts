import * as dns from "node:dns";
import * as net from "node:net";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveFetch } from "../infra/fetch.js";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
let appliedDnsResultOrder: string | null = null;
let appliedGlobalDispatcherKey: string | null = null;
const log = createSubsystemLogger("telegram/network");
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

/**
 * Create a custom DNS lookup function that uses c-ares (dns.resolve4) instead
 * of getaddrinfo (dns.lookup) for IPv4 resolution.
 *
 * On some Linux systems (Ubuntu 24.04, certain VPS providers), getaddrinfo()
 * returns unreachable IPv6 addresses or hangs entirely even when IPv4
 * connectivity is available. c-ares is a separate DNS resolver that bypasses
 * the system's getaddrinfo, making it immune to these issues.
 *
 * When the c-ares resolution fails (e.g. on IPv6-only networks or when the
 * hostname is a raw IP address), falls back to standard dns.lookup so
 * connectivity is not broken.
 *
 * See: https://github.com/openclaw/openclaw/issues/28835
 */
export function createIPv4PreferredLookup(): net.LookupFunction {
  // Node's autoSelectFamily internally calls lookup with { all: true } but
  // the LookupFunction type only declares the single-result overload. The
  // runtime handles both, so we cast at the boundary.
  const lookupImpl = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all) {
      // Resolve both A and AAAA records via c-ares so autoSelectFamily
      // can try IPv4 first while still falling back to IPv6 on
      // IPv6-only / DNS64/NAT64 networks.
      //
      // To avoid blocking on slow/dropped AAAA queries (the original
      // bug scenario), we use a grace timer: once the first query
      // returns results, we give the other query a short window (50ms)
      // to complete. If it doesn't finish in time, we return what we
      // have so undici can start connecting immediately.
      const GRACE_MS = 50;
      let returned = false;
      let v4Addrs: string[] = [];
      let v6Addrs: string[] = [];
      let v4Done = false;
      let v6Done = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const emit = () => {
        if (returned) {
          return;
        }
        returned = true;
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
        const combined: dns.LookupAddress[] = [
          ...v4Addrs.map((addr) => ({ address: addr, family: 4 as const })),
          ...v6Addrs.map((addr) => ({ address: addr, family: 6 as const })),
        ];
        if (combined.length > 0) {
          callback(null, combined);
          return;
        }
        // Both c-ares queries failed; fall back to standard dns.lookup
        // so raw IP addresses and exotic resolver configs still work.
        dns.lookup(
          hostname,
          options,
          callback as (
            err: NodeJS.ErrnoException | null,
            address: string | dns.LookupAddress[],
            family: number,
          ) => void,
        );
      };

      const onQueryDone = () => {
        if (returned) {
          return;
        }
        if (v4Done && v6Done) {
          // Both finished — emit whatever we collected.
          emit();
        } else if (v4Done && v4Addrs.length > 0) {
          // IPv4 resolved; give AAAA a brief window so autoSelectFamily
          // gets both families, but don't stall when AAAA queries are
          // dropped or very slow (the original bug scenario).
          //
          // We only start the timer on IPv4 success, never on IPv6-only
          // results. If resolve6 finishes first, we always wait for
          // resolve4 — this lookup is "IPv4-preferred" and on hosts
          // where IPv6 is present but unroutable, emitting IPv6 alone
          // would recreate the exact timeout this fix is meant to avoid.
          if (!graceTimer) {
            graceTimer = setTimeout(emit, GRACE_MS);
            graceTimer.unref();
          }
        }
        // Otherwise (one query failed, the other isn't done yet, or
        // only IPv6 returned so far) — just wait for the remaining query.
      };

      dns.resolve4(hostname, (err, addrs) => {
        if (!err && addrs?.length) {
          v4Addrs = addrs;
        }
        v4Done = true;
        onQueryDone();
      });
      dns.resolve6(hostname, (err, addrs) => {
        if (!err && addrs?.length) {
          v6Addrs = addrs;
        }
        v6Done = true;
        onQueryDone();
      });
      return;
    }

    // Single-result path: run OS resolver (dns.lookup) and c-ares
    // (dns.resolve4) in parallel. dns.lookup honors /etc/hosts and
    // split-horizon DNS rules; dns.resolve4 bypasses them but works
    // around systems where getaddrinfo hangs or returns unreachable
    // IPv6 (the original bug). Prefer the OS result when it returns
    // IPv4, so host-file overrides and local DNS pinning still work.
    {
      const GRACE_MS = 50;
      let returned = false;
      let caresAddr: string | null = null;
      let osAddr: string | null = null;
      let caresDone = false;
      let osDone = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const emit = (address: string, family: number) => {
        if (returned) {
          return;
        }
        returned = true;
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
        callback(null, address, family);
      };

      const onDone = () => {
        if (returned) {
          return;
        }

        // OS resolver returned IPv4 — prefer it (honors /etc/hosts).
        if (osDone && osAddr) {
          emit(osAddr, 4);
          return;
        }

        if (caresDone && osDone) {
          // Both finished; OS resolver didn't return IPv4.
          if (caresAddr) {
            emit(caresAddr, 4);
          } else {
            // Both failed — fall back to dns.lookup with original
            // options so raw IP addresses and exotic configs work.
            dns.lookup(
              hostname,
              options,
              callback as (
                err: NodeJS.ErrnoException | null,
                address: string | dns.LookupAddress[],
                family: number,
              ) => void,
            );
          }
          return;
        }

        if (caresDone && caresAddr && !osDone) {
          // c-ares returned IPv4; give OS resolver a brief window —
          // its answer takes priority because it honors /etc/hosts.
          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              if (returned) {
                return;
              }
              if (osAddr) {
                emit(osAddr, 4);
              } else {
                emit(caresAddr!, 4);
              }
            }, GRACE_MS);
            graceTimer.unref();
          }
        }
        // Otherwise (c-ares failed, OS resolver not done) — wait.
      };

      dns.resolve4(hostname, (err, addrs) => {
        if (!err && addrs?.length) {
          caresAddr = addrs[0];
        }
        caresDone = true;
        onDone();
      });

      dns.lookup(hostname, { ...options, family: 4 }, ((
        err: NodeJS.ErrnoException | null,
        address: string,
        family: number,
      ) => {
        if (!err && address && family === 4) {
          osAddr = address;
        }
        osDone = true;
        onDone();
      }) as (
        err: NodeJS.ErrnoException | null,
        address: string | dns.LookupAddress[],
        family: number,
      ) => void);
    }
  };
  return lookupImpl as unknown as net.LookupFunction;
}

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

  // Resolve DNS decision early so we can include a custom lookup function
  // in the global dispatcher when ipv4first is requested.
  const dnsDecision = resolveTelegramDnsResultOrderDecision({ network });

  // Node 22's built-in globalThis.fetch uses undici's internal Agent whose
  // connect options are frozen at construction time. Calling
  // net.setDefaultAutoSelectFamily() after that agent is created has no
  // effect on it. Replace the global dispatcher with one that carries the
  // current autoSelectFamily setting so subsequent globalThis.fetch calls
  // inherit the same decision.
  //
  // When dnsResultOrder is "ipv4first", also inject a custom lookup function
  // that uses c-ares (dns.resolve4) instead of getaddrinfo (dns.lookup).
  // On some Linux systems, getaddrinfo returns unreachable IPv6 addresses or
  // hangs entirely, causing ETIMEDOUT even though IPv4 connectivity works.
  // See: https://github.com/openclaw/openclaw/issues/25676
  // See: https://github.com/openclaw/openclaw/issues/28835
  const useIPv4Lookup = dnsDecision.value === "ipv4first";
  const dispatcherKey = `asf=${autoSelectDecision.value},lookup=${useIPv4Lookup}`;
  if (
    (autoSelectDecision.value !== null || useIPv4Lookup) &&
    dispatcherKey !== appliedGlobalDispatcherKey
  ) {
    const existingGlobalDispatcher = getGlobalDispatcher();
    const shouldPreserveExistingProxy =
      isProxyLikeDispatcher(existingGlobalDispatcher) && !hasProxyEnvConfigured();
    if (!shouldPreserveExistingProxy) {
      try {
        const connectOptions: Record<string, unknown> = {
          autoSelectFamilyAttemptTimeout: 300,
        };
        if (autoSelectDecision.value !== null) {
          connectOptions.autoSelectFamily = autoSelectDecision.value;
        }
        if (useIPv4Lookup) {
          connectOptions.lookup = createIPv4PreferredLookup();
        }
        setGlobalDispatcher(new EnvHttpProxyAgent({ connect: connectOptions }));
        appliedGlobalDispatcherKey = dispatcherKey;
        const parts = [];
        if (autoSelectDecision.value !== null) {
          parts.push(`autoSelectFamily=${autoSelectDecision.value}`);
        }
        if (useIPv4Lookup) {
          parts.push("lookup=ipv4-preferred(c-ares)");
        }
        log.info(`global undici dispatcher ${parts.join(", ")}`);
      } catch {
        // ignore if setGlobalDispatcher is unavailable
      }
    }
  }

  // Apply DNS result order workaround for IPv4/IPv6 issues.
  // Some APIs (including Telegram) may fail with IPv6 on certain networks.
  // See: https://github.com/openclaw/openclaw/issues/5311
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
  appliedGlobalDispatcherKey = null;
}
