import * as net from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { hasHttpProxyEnvConfigured } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedDispatcherKey: string | null = null;
let lastAppliedDispatcher: unknown = null;

type DispatcherKind = "agent" | "env-proxy" | "unsupported";

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

  const nextKind: DispatcherKind =
    kind === "agent" && hasHttpProxyEnvConfigured() ? "env-proxy" : kind;

  const autoSelectFamily = resolveAutoSelectFamily();
  const nextKey = resolveDispatcherKey({ kind: nextKind, timeoutMs, autoSelectFamily });
  if (lastAppliedDispatcherKey === nextKey && lastAppliedDispatcher === dispatcher) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (nextKind === "env-proxy") {
      const proxyOptions = {
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      const nextDispatcher = new EnvHttpProxyAgent(proxyOptions);
      setGlobalDispatcher(nextDispatcher);
      lastAppliedDispatcher = nextDispatcher;
    } else {
      const nextDispatcher = new Agent({
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
      });
      setGlobalDispatcher(nextDispatcher);
      lastAppliedDispatcher = nextDispatcher;
    }
    lastAppliedDispatcherKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedDispatcherKey = null;
  lastAppliedDispatcher = null;
}
