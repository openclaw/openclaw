import * as net from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedDispatcherKey: string | null = null;

type DispatcherKind = "agent" | "env-proxy" | "unsupported";

/**
 * Expand NO_PROXY environment variable to support leading-dot wildcards.
 * undici's EnvHttpProxyAgent only supports exact host matching.
 * This converts patterns like ".myqcloud.com" into explicit host entries
 * by also including "myqcloud.com" and ensuring the dot-prefixed pattern
 * is treated as a suffix match.
 */
export function expandNoProxyPatterns(noProxy: string): string[] {
  const entries = noProxy.split(",").map(s => s.trim()).filter(Boolean);
  const expanded: string[] = [];

  for (const entry of entries) {
    if (!entry) continue;

    // Keep original entry
    expanded.push(entry);

    // If it starts with a dot, treat it as a suffix pattern.
    // Add both the dot-prefix and non-prefix versions to improve compatibility.
    // For .myqcloud.com → add both .myqcloud.com and myqcloud.com.
    if (entry.startsWith(".")) {
      const withoutDot = entry.slice(1);
      if (!expanded.includes(withoutDot)) {
        expanded.push(withoutDot);
      }
    }

    // Add common cloud storage domains that need direct connection
    // when proxy environment is active.
    const autoAddDomains = [".myqcloud.com", "myqcloud.com"];
    for (const domain of autoAddDomains) {
      if (!expanded.includes(domain)) {
        expanded.push(domain);
      }
    }
  }

  // Deduplicate
  return [...new Set(expanded)];
}

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

function resolveAutoSelectFamily(): boolean | undefined {
  if (typeof net.getDefaultAutoSelectFamily !== "function") {
    return undefined;
  }
  try {
    return net.getDefaultAutoSelectFamily();
  } catch {
    return undefined;
  }
}

function resolveConnectOptions(
  autoSelectFamily: boolean | undefined,
): { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } | undefined {
  if (autoSelectFamily === undefined) {
    return undefined;
  }
  return {
    autoSelectFamily,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
}

function resolveDispatcherKey(params: {
  kind: DispatcherKind;
  timeoutMs: number;
  autoSelectFamily: boolean | undefined;
}): string {
  const autoSelectToken =
    params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
  return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}

export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.floor(timeoutMsRaw));
  if (!Number.isFinite(timeoutMsRaw)) {
    return;
  }

  let dispatcher: unknown;
  try {
    dispatcher = getGlobalDispatcher();
  } catch {
    return;
  }

  const kind = resolveDispatcherKind(dispatcher);
  if (kind === "unsupported") {
    return;
  }

  const autoSelectFamily = resolveAutoSelectFamily();
  const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
  if (lastAppliedDispatcherKey === nextKey) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      // Expand NO_PROXY patterns to support cloud storage domains
      // (e.g., .myqcloud.com) and leading-dot wildcards.
      const expandedNoProxy = expandNoProxyPatterns(process.env.NO_PROXY || process.env.no_proxy || "");
      const proxyOptions = {
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        noProxy: expandedNoProxy,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    } else {
      setGlobalDispatcher(
        new Agent({
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          ...(connect ? { connect } : {}),
        }),
      );
    }
    lastAppliedDispatcherKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedDispatcherKey = null;
}
