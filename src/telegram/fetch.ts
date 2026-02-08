import { Agent } from "undici";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveFetch } from "../infra/fetch.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTelegramAutoSelectFamilyDecision } from "./network-config.js";

const log = createSubsystemLogger("telegram/network");

// Singleton undici Agent with autoSelectFamily disabled for IPv6-broken servers.
// This is the actual fix for Node 22+ where net.setDefaultAutoSelectFamily() doesn't
// affect undici's fetch implementation.
let telegramAgent: Agent | null = null;

function getOrCreateTelegramAgent(): Agent {
  if (!telegramAgent) {
    telegramAgent = new Agent({
      connect: {
        autoSelectFamily: false,
      },
    });
  }
  return telegramAgent;
}

/**
 * Creates a fetch wrapper that uses an undici Agent with autoSelectFamily disabled.
 * This forces IPv4-first behavior, working around Node 22's Happy Eyeballs algorithm
 * which can fail on servers without IPv6 egress.
 */
function createIPv4PreferredFetch(baseFetch: typeof fetch): typeof fetch {
  const agent = getOrCreateTelegramAgent();
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    return baseFetch(input, {
      ...init,
      // @ts-expect-error - dispatcher is an undici-specific option not in RequestInit
      dispatcher: agent,
    });
  }) as typeof fetch;
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: { network?: TelegramNetworkConfig },
): typeof fetch | undefined {
  const decision = resolveTelegramAutoSelectFamilyDecision({ network: options?.network });

  // If using a proxy, return it directly (proxy handles its own connection logic)
  if (proxyFetch) {
    return resolveFetch(proxyFetch);
  }

  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }

  // Only wrap with IPv4-preferred agent when autoSelectFamily should be disabled
  if (decision.value === false) {
    const label = decision.source ? ` (${decision.source})` : "";
    log.info(`telegram: autoSelectFamily=${decision.value}${label}`);
    return createIPv4PreferredFetch(fetchImpl);
  }

  return fetchImpl;
}
