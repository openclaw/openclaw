import * as net from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrap = false;

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

function resolveCurrentDispatcherKind(): DispatcherKind | null {
  let dispatcher: unknown;
  try {
    dispatcher = getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  return currentKind === "unsupported" ? null : currentKind;
}

export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  const shouldUseEnvProxy = hasEnvHttpProxyConfigured("https");
  if (!shouldUseEnvProxy) {
    return;
  }
  if (lastAppliedProxyBootstrap) {
    if (resolveCurrentDispatcherKind() === "env-proxy") {
      return;
    }
    lastAppliedProxyBootstrap = false;
  }
  const currentKind = resolveCurrentDispatcherKind();
  if (currentKind === null) {
    return;
  }
  if (currentKind === "env-proxy") {
    lastAppliedProxyBootstrap = true;
    return;
  }
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    lastAppliedProxyBootstrap = true;
  } catch {
    // Best-effort bootstrap only.
  }
}

export function ensureGlobalUndiciStreamTimeouts(opts?: {
  timeoutMs?: number;
  headersTimeoutMs?: number;
}): void {
  const bodyTimeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  const bodyTimeoutMs = Math.max(1, Math.floor(bodyTimeoutMsRaw));
  if (!Number.isFinite(bodyTimeoutMsRaw)) {
    return;
  }
  // headersTimeout defaults to the overall default independently so that a
  // short bodyTimeout (e.g. 5 s to detect stalled SSE streams) does not also
  // shorten the time allowed to receive initial response headers.
  const headersTimeoutMsRaw = opts?.headersTimeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  const headersTimeoutMs = Math.max(1, Math.floor(headersTimeoutMsRaw));
  if (!Number.isFinite(headersTimeoutMsRaw)) {
    return;
  }

  const kind = resolveCurrentDispatcherKind();
  if (kind === null) {
    return;
  }

  const autoSelectFamily = resolveAutoSelectFamily();
  const nextKey =
    resolveDispatcherKey({ kind, timeoutMs: bodyTimeoutMs, autoSelectFamily }) +
    `:h${headersTimeoutMs}`;
  if (lastAppliedTimeoutKey === nextKey) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      const proxyOptions = {
        bodyTimeout: bodyTimeoutMs,
        headersTimeout: headersTimeoutMs,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    } else {
      setGlobalDispatcher(
        new Agent({
          bodyTimeout: bodyTimeoutMs,
          headersTimeout: headersTimeoutMs,
          ...(connect ? { connect } : {}),
        }),
      );
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrap = false;
}
