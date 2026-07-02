// Global Undici dispatcher setup keeps process-wide proxy routing, HTTP/1-only
// enforcement, and long stream timeouts aligned across root fetch imports.
import { isProxylineDispatcher } from "@openclaw/proxyline/dispatcher-brand";
import {
  hasEnvHttpProxyAgentConfigured,
  matchesNoProxy,
  resolveEnvHttpProxyAgentOptions,
} from "./proxy-env.js";
import { addActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";
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

/** When true, the enhanced bypass matching (CIDR ranges,
 *  octet wildcards support beyond what undici's built-in matcher
 *  handles) is applied to all global fetch requests routed through
 *  the proxy.  Default is false
 *  (opt-in) — set via `proxy.enhancedNoProxy` config or
 *  ensureGlobalUndiciEnvProxyDispatcher({ enhancedNoProxy }). */
let enhancedNoProxyEnabled = false;
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export let globalUndiciStreamTimeoutMs: number | undefined;

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

/** Creates a direct Agent for proxy-bypassed requests, using the same
 * timeout and connect policy as the EnvHttpProxyAgent would have used. */
function createDirectBypassAgent(params: {
  timeoutMs: number;
  connect?: Record<string, unknown>;
}): UndiciDispatcher {
  return createHttp1Agent(params.connect ? { ...params.connect } : undefined, params.timeoutMs);
}

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

function withDefaultDispatchTimeout(
  timeout: UndiciDispatchOptions["bodyTimeout"],
  timeoutMs: number,
): UndiciDispatchOptions["bodyTimeout"] {
  return timeout == null ? timeoutMs : timeout;
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
            bodyTimeout: withDefaultDispatchTimeout(options.bodyTimeout, state.timeoutMs),
            headersTimeout: withDefaultDispatchTimeout(options.headersTimeout, state.timeoutMs),
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

/**
 * Wraps an EnvHttpProxyAgent so each request is first checked against
 * OpenClaw's enhanced proxy-bypass matcher (with CIDR/octet-wildcard
 * subdomain support that undici's built-in NO_PROXY does not handle).
 *
 * When the origin matches NO_PROXY, the request is routed through a
 * direct Agent; otherwise it uses the EnvHttpProxyAgent as usual.
 *
 * NOTE: undici v8.5.0 natively handles basic domain and leading-dot
 * NO_PROXY patterns (e.g. .myqcloud.com → stripped to myqcloud.com
 * for subdomain suffix matching). OpenClaw's enhanced matcher adds:
 *   - CIDR ranges: 10.0.0.0/8, 100.64.0.0/10
 *   - Octet wildcards: 192.168.*.*
 *
 * This wrapper is opt-in by default (enhancedNoProxyEnabled = false).
 * It is only applied when proxy.enhancedNoProxy is explicitly enabled.
 * The caller must ensure the proxy IS configured before creating this
 * wrapper; `hasEnvHttpProxyAgentConfigured()` is not re-checked on
 * every dispatch because `forceResetGlobalDispatcher()` replaces the
 * dispatcher if proxy env is later cleared.
 */
function createNoProxyAwareEnvDispatcher(
  envProxyDispatcher: UndiciDispatcher,
  bypassAgent: UndiciDispatcher,
): UndiciDispatcher {
  if (!enhancedNoProxyEnabled) {
    return envProxyDispatcher;
  }
  return new Proxy(envProxyDispatcher, {
    get(target, property, receiver) {
      if (property === "dispatch") {
        return (options: UndiciDispatchOptions, handler: UndiciDispatchHandler): boolean => {
          const origin =
            typeof options.origin === "string"
              ? options.origin
              : options.origin instanceof URL
                ? options.origin.href
                : undefined;
          if (origin && matchesNoProxy(origin)) {
            return bypassAgent.dispatch(options, handler);
          }
          return target.dispatch(options, handler);
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (UNDICI_DISPATCHER_LIFECYCLE_METHODS.has(property)) {
        // Return a consistent Promise<undefined> from ALL paths so the
        // check-lint consistent-return rule passes.  Callback callers
        // ignore the returned Promise; promise-style callers await it.
        return (...args: unknown[]): Promise<undefined> => {
          const cbIdx = args.length - 1;
          const cb = typeof args[cbIdx] === "function" ? (args[cbIdx] as Function) : undefined;
          const lifecycleArgs = cb ? args.slice(0, cbIdx) : args;

          // Collect dispatchers that implement this lifecycle method.
          const dispatchersWithMethod = [target, bypassAgent].filter(
            (d) => typeof Reflect.get(d, property, d) === "function",
          );

          if (dispatchersWithMethod.length === 0) {
            if (cb) {
              cb();
            }
            return Promise.resolve(undefined);
          }

          if (cb) {
            let pending = dispatchersWithMethod.length;
            let firstErr: unknown;
            const onSettled = (err?: unknown) => {
              if (firstErr === undefined) {
                firstErr = err;
              }
              if (--pending === 0) {
                cb(firstErr !== undefined ? firstErr : undefined);
              }
            };
            for (const d of dispatchersWithMethod) {
              try {
                (Reflect.get(d, property, d) as Function).call(
                  d,
                  ...lifecycleArgs,
                  onSettled,
                );
              } catch (e) {
                onSettled(e);
              }
            }
            return Promise.resolve(undefined);
          }

          // Promise-style: invoke all available lifecycle methods.
          return Promise.all(
            dispatchersWithMethod.map((d) =>
              Promise.resolve(
                (Reflect.get(d, property, d) as Function).call(d, ...lifecycleArgs),
              ),
            ),
          ).then(() => undefined);
        };
      }
      if (UNDICI_DISPATCH_HELPER_METHODS.has(property)) {
        return (...args: unknown[]) => Reflect.apply(value, receiver, args);
      }
      return value;
    },
  });
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

function resolveDispatcherKey(params: {
  kind: DispatcherKind;
  timeoutMs: number;
  autoSelectFamily: boolean | undefined;
}): string {
  const autoSelectToken =
    params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
  return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}

function resolveEnvProxyDispatcherOptions(): ConstructorParameters<
  UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]
>[0] {
  return {
    ...addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions()),
    ...HTTP1_ONLY_DISPATCHER_OPTIONS,
  } as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0];
}

function resolveEnvProxyBootstrapKey(
  options: ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0],
): string {
  const entries = Object.entries((options ?? {}) as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .toSorted(([a], [b]) => a.localeCompare(b));
  // Include enhancedNoProxy in the bootstrap key so changing the flag
  // forces a dispatcher rebuild.
  return JSON.stringify(entries) + `|enhancedNoProxy=${enhancedNoProxyEnabled}`;
}

function resolveStreamTimeoutMs(opts?: { timeoutMs?: number }): number | null {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMsRaw)) {
    return null;
  }
  return Math.max(DEFAULT_UNDICI_STREAM_TIMEOUT_MS, Math.floor(timeoutMsRaw));
}

function resolveCurrentDispatcherKind(
  runtime: Pick<UndiciGlobalDispatcherDeps, "getGlobalDispatcher">,
): SupportedDispatcherKind | null {
  return resolveCurrentDispatcherInfo(runtime)?.kind ?? null;
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
export function ensureGlobalUndiciEnvProxyDispatcher(opts?: { enhancedNoProxy?: boolean }): void {
  if (opts?.enhancedNoProxy !== undefined) {
    enhancedNoProxyEnabled = opts.enhancedNoProxy;
  }
  const shouldUseEnvProxy = hasEnvHttpProxyAgentConfigured();
  if (!shouldUseEnvProxy) {
    return;
  }
  const runtime = loadUndiciGlobalDispatcherDeps();
  const { setGlobalDispatcher } = runtime;
  const proxyOptions = resolveEnvProxyDispatcherOptions();
  const nextBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  const currentKind = resolveCurrentDispatcherKind(runtime);
  if (currentKind === null) {
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
    setGlobalDispatcher(
      createNoProxyAwareEnvDispatcher(
        createHttp1EnvHttpProxyAgent(proxyOptions),
        createDirectBypassAgent({
          timeoutMs: DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
          connect: proxyOptions?.connect as Record<string, unknown> | undefined,
        }),
      ),
    );
    lastAppliedProxyBootstrapKey = nextBootstrapKey;
  } catch {
    // Best-effort bootstrap only.
  }
}

function applyGlobalDispatcherStreamTimeouts(params: {
  runtime: UndiciGlobalDispatcherDeps;
  dispatcher: UndiciDispatcher;
  kind: SupportedDispatcherKind;
  timeoutMs: number;
}): void {
  const { runtime, dispatcher, kind, timeoutMs } = params;
  const autoSelectFamily = resolveUndiciAutoSelectFamily();
  const nextKey = resolveDispatcherKey({
    kind,
    timeoutMs,
    autoSelectFamily,
  });
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
        ...addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions()),
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
        ...HTTP1_ONLY_DISPATCHER_OPTIONS,
      } as ConstructorParameters<UndiciGlobalDispatcherDeps["EnvHttpProxyAgent"]>[0];
      runtime.setGlobalDispatcher(
        createNoProxyAwareEnvDispatcher(
          createHttp1EnvHttpProxyAgent(proxyOptions, timeoutMs),
          createDirectBypassAgent({
            timeoutMs,
            connect: proxyOptions?.connect as Record<string, unknown> | undefined,
          }),
        ),
      );
    } else {
      runtime.setGlobalDispatcher(createHttp1Agent(connect ? { connect } : undefined, timeoutMs));
    }
    lastAppliedTimeoutKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

/**
 * Records the stream timeout bridge and applies it only when the current global
 * dispatcher already uses env or managed proxy routing.
 */
export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMs = resolveStreamTimeoutMs(opts);
  if (timeoutMs === null) {
    return;
  }
  globalUndiciStreamTimeoutMs = timeoutMs;
  if (!hasEnvHttpProxyAgentConfigured()) {
    lastAppliedTimeoutKey = null;
    return;
  }
  const runtime = loadUndiciGlobalDispatcherDeps();
  const current = resolveCurrentDispatcherInfo(runtime);
  if (current === null) {
    return;
  }
  if (current.kind !== "env-proxy" && current.kind !== "proxyline-managed") {
    return;
  }

  applyGlobalDispatcherStreamTimeouts({
    runtime,
    dispatcher: current.dispatcher,
    kind: current.kind,
    timeoutMs,
  });
}

/** Forces timeout/family policy onto the current supported global dispatcher. */
export function ensureGlobalUndiciDispatcherStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMs = resolveStreamTimeoutMs(opts);
  if (timeoutMs === null) {
    return;
  }
  globalUndiciStreamTimeoutMs = timeoutMs;
  const runtime = loadUndiciGlobalDispatcherDeps();
  const current = resolveCurrentDispatcherInfo(runtime);
  if (current === null) {
    return;
  }
  applyGlobalDispatcherStreamTimeouts({
    runtime,
    dispatcher: current.dispatcher,
    kind: current.kind,
    timeoutMs,
  });
}

/** Clears module-level dispatcher bookkeeping between isolated tests. */
export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedTimeoutKey = null;
  lastAppliedProxyBootstrapKey = null;
  globalUndiciStreamTimeoutMs = undefined;
  enhancedNoProxyEnabled = false;
}

/**
 * Re-evaluate proxy env changes for root undici imports. Installs
 * EnvHttpProxyAgent when proxy env is present, and restores a direct Agent
 * after proxy env is cleared.
 */
export function forceResetGlobalDispatcher(opts?: { preserveProxylineManaged?: boolean }): void {
  lastAppliedTimeoutKey = null;
  if (!hasEnvHttpProxyAgentConfigured()) {
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
    const proxyOptions = resolveEnvProxyDispatcherOptions();
    if (opts?.preserveProxylineManaged) {
      const current = resolveCurrentDispatcherInfo(runtime);
      if (current?.kind === "proxyline-managed") {
        lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
        return;
      }
    }
    setGlobalDispatcher(
      createNoProxyAwareEnvDispatcher(
        createHttp1EnvHttpProxyAgent(proxyOptions),
        createDirectBypassAgent({
          timeoutMs: DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
          connect: proxyOptions?.connect as Record<string, unknown> | undefined,
        }),
      ),
    );
    lastAppliedProxyBootstrapKey = resolveEnvProxyBootstrapKey(proxyOptions);
  } catch {
    // Best-effort reset only.
  }
}
