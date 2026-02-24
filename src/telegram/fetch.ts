import * as dns from "node:dns";
import * as net from "node:net";
import type { Dispatcher } from "undici";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
let appliedDnsResultOrder: string | null = null;
const log = createSubsystemLogger("telegram/network");

let ipv4DispatcherPromise: Promise<Dispatcher | null> | null = null;
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

async function getIpv4DispatcherAsync(): Promise<Dispatcher | null> {
  if (!ipv4DispatcherPromise) {
    ipv4DispatcherPromise = (async () => {
      try {
        const { Agent } = await import("undici");
        log.info("Creating Undici Dispatcher to force IPv4 logic");
        return new Agent({
          connect: {
            lookup: (hostname, options, callback) => {
              dns.lookup(hostname, { ...options, family: 4 }, callback);
            },
          },
        });
      } catch (err) {
        log.warn(`Could not initialize undici IPv4 dispatcher: ${String(err)}`);
        return null;
      }
    })();
  }
  return ipv4DispatcherPromise;
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

export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);
  if (proxyFetch) {
    return proxyFetch;
  }
  if (typeof globalThis.fetch === "function") {
    return async (url, init) => {
      const dispatcher = await getIpv4DispatcherAsync();
      const finalInit: RequestInitWithDispatcher = dispatcher
        ? { ...init, dispatcher }
        : (init ?? {});

      // Note: intentionally removed noisy tracer logs
      return await globalThis.fetch(url, finalInit);
    };
  }
  throw new Error("fetch is not available; set channels.telegram.proxy in config");
}

export function resetTelegramFetchStateForTests(): void {
  appliedAutoSelectFamily = null;
  appliedDnsResultOrder = null;
  ipv4DispatcherPromise = null;
}
