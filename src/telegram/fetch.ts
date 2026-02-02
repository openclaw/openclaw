import * as net from "node:net";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveFetch } from "../infra/fetch.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTelegramAutoSelectFamilyDecision } from "./network-config.js";

let appliedAutoSelectFamily: boolean | null = null;
const log = createSubsystemLogger("telegram/network");

// Node 22 workaround: disable autoSelectFamily to avoid Happy Eyeballs timeouts.
// See: https://github.com/nodejs/node/issues/54359
function applyTelegramNetworkWorkarounds(network?: TelegramNetworkConfig): void {
  const decision = resolveTelegramAutoSelectFamilyDecision({ network });
  if (decision.value === null || decision.value === appliedAutoSelectFamily) {
    return;
  }
  appliedAutoSelectFamily = decision.value;

  if (typeof net.setDefaultAutoSelectFamily === "function") {
    try {
      net.setDefaultAutoSelectFamily(decision.value);
      const label = decision.source ? ` (${decision.source})` : "";
      log.info(`telegram: autoSelectFamily=${decision.value}${label}`);
    } catch {
      // ignore if unsupported by the runtime
    }
  }
}

type TelegramFetchOptions = {
  network?: TelegramNetworkConfig;
  timeoutMs?: number;
};

type FetchWithPreconnect = typeof fetch & {
  preconnect: (url: string, init?: { credentials?: RequestCredentials }) => void;
};

type TimeoutFilter = (input: RequestInfo | URL, init?: RequestInit) => boolean;

function resolveFetchUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  const candidate = input as { url?: unknown };
  return typeof candidate.url === "string" ? candidate.url : undefined;
}

function isTelegramGetUpdatesRequest(input: RequestInfo | URL): boolean {
  const url = resolveFetchUrl(input);
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.pathname.toLowerCase().endsWith("/getupdates");
  } catch {
    return false;
  }
}

function wrapFetchWithTimeout(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  shouldTimeout?: TimeoutFilter,
): typeof fetch {
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return fetchImpl(input, init);
    }
    if (shouldTimeout && !shouldTimeout(input, init)) {
      return fetchImpl(input, init);
    }
    if (typeof AbortController === "undefined") {
      return fetchImpl(input, init);
    }
    const controller = new AbortController();
    const signal = init?.signal;
    const onAbort = () => controller.abort();

    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    } else if (signal && (signal as { aborted?: boolean }).aborted) {
      controller.abort();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!controller.signal.aborted) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    const response = fetchImpl(input, { ...(init ?? {}), signal: controller.signal });
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };
    void response.finally(cleanup);
    return response;
  }) as FetchWithPreconnect;

  const fetchWithPreconnect = fetchImpl as FetchWithPreconnect;
  wrapped.preconnect =
    typeof fetchWithPreconnect.preconnect === "function"
      ? fetchWithPreconnect.preconnect.bind(fetchWithPreconnect)
      : () => {};

  return Object.assign(wrapped, fetchImpl);
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: TelegramFetchOptions,
): typeof fetch | undefined {
  applyTelegramNetworkWorkarounds(options?.network);
  if (proxyFetch) {
    const fetchImpl = resolveFetch(proxyFetch);
    if (fetchImpl && options?.timeoutMs) {
      // Only apply long-poll timeouts to getUpdates to avoid aborting uploads.
      return wrapFetchWithTimeout(fetchImpl, options.timeoutMs, isTelegramGetUpdatesRequest);
    }
    return fetchImpl;
  }
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  if (options?.timeoutMs) {
    // Only apply long-poll timeouts to getUpdates to avoid aborting uploads.
    return wrapFetchWithTimeout(fetchImpl, options.timeoutMs, isTelegramGetUpdatesRequest);
  }
  return fetchImpl;
}
