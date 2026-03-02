import * as dns from "node:dns";
import * as net from "node:net";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
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

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);
  if (proxyFetch) {
    return resolveFetch(proxyFetch);
  }
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return fetchImpl;
}

export function resetTelegramFetchStateForTests(): void {
  appliedAutoSelectFamily = null;
  appliedDnsResultOrder = null;
  appliedGlobalDispatcherAutoSelectFamily = null;
}
