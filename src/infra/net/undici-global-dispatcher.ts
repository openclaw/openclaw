import * as net from "node:net";
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { logWarn } from "../../logger.js";
import { PROXY_ENV_KEYS } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedDispatcherKey: string | null = null;

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

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedDispatcherKey = null;
}

/**
 * If any proxy env var (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, or their lowercase
 * variants) is set, install an EnvHttpProxyAgent as the global undici dispatcher
 * so that bare fetch() calls — including those from third-party SDKs that do not
 * accept a custom fetch — route through the configured proxy.
 *
 * Using setGlobalDispatcher() rather than replacing globalThis.fetch keeps the
 * approach composable: subsequent ensureGlobalUndiciStreamTimeouts() calls can
 * still detect and upgrade the dispatcher with timeout settings.
 *
 * Returns the name of the env var that triggered the change, or undefined when
 * no proxy is configured or the dispatcher could not be set.
 */
export function applyEnvProxyToGlobalDispatcher(): string | undefined {
  let detectedKey: string | undefined;
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]?.trim()) {
      detectedKey = key;
      break;
    }
  }
  if (!detectedKey) {
    return undefined;
  }
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    // Reset memoised key so the next ensureGlobalUndiciStreamTimeouts() call
    // picks up the new env-proxy dispatcher and applies timeout settings.
    lastAppliedDispatcherKey = null;
    return detectedKey;
  } catch (err) {
    logWarn(
      `Proxy env var set but EnvHttpProxyAgent dispatcher could not be installed — bare fetch() calls may bypass the proxy: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
