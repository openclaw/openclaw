import * as net from "node:net";
import {
  Agent,
  type Dispatcher,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { hasProxyEnvConfigured } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedDispatcherKey: string | null = null;
let temporaryEnvProxyScopeDepth = 0;
let temporaryEnvProxyRestoreDispatcher: Dispatcher | null = null;

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

  const autoSelectFamily = resolveAutoSelectFamily();
  const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
  if (lastAppliedDispatcherKey === nextKey) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      const proxyOptions = {
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
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

export async function withTemporaryEnvProxyDispatcher<T>(
  fn: () => Promise<T> | T,
  opts?: { timeoutMs?: number },
): Promise<T> {
  if (!hasProxyEnvConfigured()) {
    return await fn();
  }

  let dispatcher: Dispatcher;
  try {
    dispatcher = getGlobalDispatcher();
  } catch {
    return await fn();
  }

  const kind = resolveDispatcherKind(dispatcher);
  if (kind === "unsupported") {
    return await fn();
  }
  if (temporaryEnvProxyScopeDepth > 0) {
    temporaryEnvProxyScopeDepth += 1;
    try {
      return await fn();
    } finally {
      temporaryEnvProxyScopeDepth -= 1;
      if (temporaryEnvProxyScopeDepth === 0) {
        const restoreDispatcher = temporaryEnvProxyRestoreDispatcher;
        temporaryEnvProxyRestoreDispatcher = null;
        if (restoreDispatcher) {
          try {
            setGlobalDispatcher(restoreDispatcher);
          } catch {
            // Best-effort restore only.
          }
        }
      }
    }
  }
  if (kind === "env-proxy") {
    return await fn();
  }

  const connect = resolveConnectOptions(resolveAutoSelectFamily());
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.floor(timeoutMsRaw));
  temporaryEnvProxyRestoreDispatcher = dispatcher;
  temporaryEnvProxyScopeDepth = 1;
  try {
    const proxyOptions = {
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      ...(connect ? { connect } : {}),
    } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
    setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
  } catch {
    temporaryEnvProxyScopeDepth = 0;
    temporaryEnvProxyRestoreDispatcher = null;
    return await fn();
  }

  try {
    return await fn();
  } finally {
    temporaryEnvProxyScopeDepth -= 1;
    if (temporaryEnvProxyScopeDepth === 0) {
      const restoreDispatcher = temporaryEnvProxyRestoreDispatcher;
      temporaryEnvProxyRestoreDispatcher = null;
      if (restoreDispatcher) {
        try {
          setGlobalDispatcher(restoreDispatcher);
        } catch {
          // Best-effort restore only.
        }
      }
    }
  }
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedDispatcherKey = null;
  temporaryEnvProxyScopeDepth = 0;
  temporaryEnvProxyRestoreDispatcher = null;
}
