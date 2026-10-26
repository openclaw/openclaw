// Global Undici dispatcher setup keeps process-wide proxy routing, HTTP/1-only
// enforcement, and long stream timeouts aligned across root fetch imports.
import { isProxylineDispatcher } from "@openclaw/proxyline/dispatcher-brand";
import {
  resolveEnvHttpProxyAgentOptions,
  type EnvHttpProxyAgentProxyOptions,
} from "./proxy-env.js";
import { resolveActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";
import { setGlobalUndiciStreamTimeoutMs } from "./undici-dispatcher-options.js";
import {
  createUndiciAutoSelectFamilyConnectOptions,
  resolveUndiciAutoSelectFamily,
  withTemporaryUndiciAutoSelectFamily,
} from "./undici-family-policy.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  loadUndiciGlobalDispatcherDeps,
  type UndiciGlobalDispatcherDeps,
} from "./undici-runtime.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

let lastAppliedTimeoutKey: string | null = null;
let lastAppliedProxyBootstrapKey: string | null = null;

type DispatcherKind = "agent" | "env-proxy" | "proxyline-managed" | "unsupported";
type SupportedDispatcherKind = Exclude<DispatcherKind, "unsupported">;
type UndiciDispatcher = Parameters<UndiciGlobalDispatcherDeps["setGlobalDispatcher"]>[0];
type UndiciDispatchOptions = Parameters<UndiciDispatcher["dispatch"]>[0];
type UndiciDispatchHandler = Parameters<UndiciDispatcher["dispatch"]>[1];
type CurrentDispatcherInfo = {
  kind: SupportedDispatcherKind;
  dispatcher: UndiciDispatcher;
};
type TimedProxylineManagedDispatcherState = {
  autoSelectFamily: boolean | undefined;
  timeoutMs: number;
  dispatch: UndiciDispatcher["dispatch"];
};

const UNDICI_DISPATCH_HELPER_METHODS = new Set<PropertyKey>([
  "compose",
  "connect",
  "pipeline",
  "request",
  "stream",
  "upgrade",
]);
const UNDICI_DISPATCHER_LIFECYCLE_METHODS = new Set<PropertyKey>(["close", "destroy"]);

const timedProxylineManagedDispatchers = new WeakMap<
  object,
  TimedProxylineManagedDispatcherState
>();

function isTimedProxylineManagedDispatcher(dispatcher: unknown): dispatcher is UndiciDispatcher {
  return typeof dispatcher === "object" && dispatcher !== null
    ? timedProxylineManagedDispatchers.has(dispatcher)
    : false;
}

function createTimedProxylineManagedDispatcher(
  dispatcher: UndiciDispatcher,
  timeoutMs: number,
  autoSelectFamily: boolean | undefined,
): UndiciDispatcher {
  const existingState = timedProxylineManagedDispatchers.get(dispatcher);
  if (existingState) {
    // Managed proxy dispatchers may be reconfigured in place; update the shared
    // state so existing wrappers pick up timeout/family changes without nesting.
    existingState.autoSelectFamily = autoSelectFamily;
    existingState.timeoutMs = timeoutMs;
    return dispatcher;
  }

  const state: TimedProxylineManagedDispatcherState = {
    autoSelectFamily,
    timeoutMs,
    dispatch(options: UndiciDispatchOptions, handler: UndiciDispatchHandler): boolean {
      return withTemporaryUndiciAutoSelectFamily(state.autoSelectFamily, () =>
        dispatcher.dispatch(
          {
            ...options,
            bodyTimeout: options.bodyTimeout ?? state.timeoutMs,
            headersTimeout: options.headersTimeout ?? state.timeoutMs,
            ...HTTP1_ONLY_DISPATCHER_OPTIONS,
          },
          handler,
        ),
      );
    },
  };
  const proxy = new Proxy(dispatcher, {
    get(target, property, receiver) {
      if (property === "dispatch") {
        return state.dispatch;
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (UNDICI_DISPATCHER_LIFECYCLE_METHODS.has(property)) {
        // Lifecycle calls must hit the original dispatcher so close/destroy do
        // not recurse through helper methods that intentionally see the proxy.
        return value.bind(target);
      }
      if (UNDICI_DISPATCH_HELPER_METHODS.has(property)) {
        // Undici helper methods expect the dispatcher proxy as `this` so they
        // still route through our wrapped dispatch implementation.
        return (...args: unknown[]) => Reflect.apply(value, receiver, args);
      }
      return value;
    },
  });
  timedProxylineManagedDispatchers.set(proxy, state);
  return proxy;
}

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (isTimedProxylineManagedDispatcher(dispatcher) || isProxylineDispatcher(dispatcher)) {
    return "proxyline-managed";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

function resolveEnvProxyBootstrapKey(options: EnvHttpProxyAgentProxyOptions): string {
  // Either hop can own managed trust; rotating one must replace the pooled dispatcher.
  const proxyTls = [...new Set([options.httpProxy, options.httpsProxy])].map((proxyUrl) =>
    proxyUrl ? resolveActiveManagedProxyTlsOptions({ proxyUrl }) : undefined,
  );
  return JSON.stringify([options.httpProxy, options.httpsProxy, proxyTls]);
}

function resolveCurrentDispatcherInfo(
  runtime: Pick<UndiciGlobalDispatcherDeps, "getGlobalDispatcher">,
): CurrentDispatcherInfo | null {
  let dispatcher: unknown;
  try {
    dispatcher = runtime.getGlobalDispatcher();
  } catch {
    return null;
  }

  const currentKind = resolveDispatcherKind(dispatcher);
  if (currentKind === "unsupported") {
    return null;
  }
  return {
    kind: currentKind,
    dispatcher: dispatcher as UndiciDispatcher,
  };
}

/** Installs the env-proxy global dispatcher once proxy env is available. */
export function ensureGlobalUndiciEnvProxyDispatcher(): void {
  const proxyOptions = resolveEnvHttpProxyAgentOptions();
  if (!proxyOptions) {
    return;
  }
  const runtime = loadUndiciGlobalDispatcherDeps();
  const { setGlobalDispatcher } = runtime;
  const nextBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  const currentKind = resolveCurrentDispatcherInfo(runtime)?.kind;
  if (currentKind === undefined) {
    return;
  }
  if (currentKind === "proxyline-managed") {
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
    return;
  }
  if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === null) {
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
    return;
  }
  if (currentKind === "env-proxy" && lastAppliedProxyBootstrapKey === nextBootstrapKey) {
    return;
  }
  try {
    setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions));
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
  } catch {
    // Best-effort bootstrap only.
  }
}

/** Forces timeout/family policy onto the current supported global dispatcher. */
export function ensureGlobalUndiciDispatcherStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return;
  }
  const timeoutMs = Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
  setGlobalUndiciStreamTimeoutMs(timeoutMs);
  const runtime = loadUndiciGlobalDispatcherDeps();
  const current = resolveCurrentDispatcherInfo(runtime);
  if (current === null) {
    return;
  }
  const { dispatcher, kind } = current;
  const autoSelectFamily = resolveUndiciAutoSelectFamily();
  const autoSelectToken = autoSelectFamily === undefined ? "na" : autoSelectFamily ? "on" : "off";
  const nextKey = `${kind}:${timeoutMs}:${autoSelectToken}`;
  const needsProxylineWrapper =
    kind === "proxyline-managed" && !isTimedProxylineManagedDispatcher(dispatcher);
  if (lastAppliedTimeoutKey === nextKey && !needsProxylineWrapper) {
    return;
  }

  const connect = createUndiciAutoSelectFamilyConnectOptions(autoSelectFamily);
  try {
    if (kind === "proxyline-managed") {
      runtime.setGlobalDispatcher(
        createTimedProxylineManagedDispatcher(dispatcher, timeoutMs, autoSelectFamily),
      );
    } else if (kind === "env-proxy") {
      const proxyOptions = {
        ...resolveEnvHttpProxyAgentOptions(),
        ...(connect ? { connect } : {}),
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
      };
      runtime.setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions));
    } else {
      runtime.setGlobalDispatcher(
        createHttp1Agent({ connect, bodyTimeout: timeoutMs, headersTimeout: timeoutMs }),
      );
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

/** Clears module-level dispatcher bookkeeping between isolated tests. */
export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrapKey = null;
  setGlobalUndiciStreamTimeoutMs(undefined);
}

/**
 * Re-evaluate proxy env changes for root undici imports. Installs
 * EnvHttpProxyAgent when proxy env is present, and restores a direct Agent
 * after proxy env is cleared.
 */
export function forceResetGlobalDispatcher(opts?: { preserveProxylineManaged?: boolean }): void {
  lastAppliedTimeoutKey = null;
  const proxyOptions = resolveEnvHttpProxyAgentOptions();
  if (!proxyOptions) {
    if (lastAppliedProxyBootstrapKey === null) {
      return;
    }
    lastAppliedProxyBootstrapKey = null;
    try {
      const { setGlobalDispatcher } = loadUndiciGlobalDispatcherDeps();
      setGlobalDispatcher(createHttp1Agent());
    } catch {
      // Best-effort reset only.
    }
    return;
  }
  try {
    const runtime = loadUndiciGlobalDispatcherDeps();
    const { setGlobalDispatcher } = runtime;
    if (opts?.preserveProxylineManaged) {
      const current = resolveCurrentDispatcherInfo(runtime);
      if (current?.kind === "proxyline-managed") {
        lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
        return;
      }
    }
    setGlobalDispatcher(createHttp1EnvHttpProxyAgent(proxyOptions));
    lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  } catch {
    // Best-effort reset only.
  }
}
