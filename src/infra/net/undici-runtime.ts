// Undici runtime helpers lazily load dispatcher constructors and enforce
// OpenClaw HTTP/1, timeout, proxy TLS, and IP-safe proxy policies.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { logDebug } from "../../logger.js";
import { formatErrorMessage } from "../errors.js";
import { addActiveManagedProxyTlsOptions } from "./proxy/managed-proxy-undici.js";
import { resolveUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const requireUndici = createRequire(import.meta.url);

/** Runtime-loaded undici constructors/functions used where static imports would affect globals. */
export type UndiciRuntimeDeps = {
  Agent: typeof import("undici").Agent;
  Client: typeof import("undici").Client;
  EnvHttpProxyAgent: typeof import("undici").EnvHttpProxyAgent;
  FormData?: typeof import("undici").FormData;
  Pool: typeof import("undici").Pool;
  ProxyAgent: typeof import("undici").ProxyAgent;
  fetch: typeof import("undici").fetch;
};

/** Minimal undici surface needed by global-dispatcher installation code. */
export type UndiciGlobalDispatcherDeps = Pick<UndiciRuntimeDeps, "Agent" | "EnvHttpProxyAgent"> & {
  getGlobalDispatcher: typeof import("undici").getGlobalDispatcher;
  setGlobalDispatcher: typeof import("undici").setGlobalDispatcher;
};

type UndiciAgentOptions = ConstructorParameters<UndiciRuntimeDeps["Agent"]>[0];
type UndiciClientOptions = ConstructorParameters<UndiciRuntimeDeps["Client"]>[1];
type UndiciEnvHttpProxyAgentOptions = ConstructorParameters<
  UndiciRuntimeDeps["EnvHttpProxyAgent"]
>[0];
type UndiciProxyAgentOptions = ConstructorParameters<UndiciRuntimeDeps["ProxyAgent"]>[0];
type UndiciProxyAgentOptionsRecord = Exclude<UndiciProxyAgentOptions, string | URL>;
type UndiciProxyClientFactory = NonNullable<UndiciProxyAgentOptionsRecord["clientFactory"]>;
type UndiciDispatcher = import("undici").Dispatcher;
type UnknownFunction = (...args: unknown[]) => unknown;

// Guarded fetch dispatchers intentionally stay on HTTP/1.1. Undici 8 enables
// HTTP/2 ALPN by default, but our guarded paths rely on dispatcher overrides
// that have not been reliable on the HTTP/2 path yet.
const HTTP1_ONLY_DISPATCHER_OPTIONS = Object.freeze({
  allowH2: false as const,
});

function logUndiciDispatcherError(error: unknown): void {
  logDebug(`undici: internal dispatcher error: ${formatErrorMessage(error)}`);
}

function withUndiciErrorDiagnostics<T extends UndiciDispatcher>(dispatcher: T): T {
  // Body consumers already receive the failure. This listener prevents the
  // EventEmitter error channel from turning that same failure into a crash.
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", logUndiciDispatcherError);
  }
  return dispatcher;
}

function applyMissingConnectOptions(
  connect: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in connect)) {
      connect[key] = value;
    }
  }
}

function loadUndiciModule(
  requiredExports: ReadonlyArray<keyof typeof import("undici")>,
): typeof import("undici") {
  const override = (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
  if (
    isObjectRecord(override) &&
    requiredExports.every((key) => typeof override[key] === "function")
  ) {
    return override as typeof import("undici");
  }
  return requireUndici("undici") as typeof import("undici");
}

function stripIpServernameFromConnectOptions(options: unknown): unknown {
  // OpenSSL rejects IP literals as SNI values; strip only IP servernames while
  // preserving hostname SNI for HTTPS proxies.
  if (!isObjectRecord(options) || typeof options.servername !== "string") {
    return options;
  }
  const servername = options.servername.replace(/^\[|\]$/g, "");
  if (net.isIP(servername) === 0) {
    return options;
  }
  const next = { ...options };
  delete next.servername;
  return next;
}

function stripIpServernameFromConnect(connect: unknown): unknown {
  if (typeof connect !== "function") {
    return connect;
  }
  return (options: unknown, callback: unknown): unknown =>
    (connect as UnknownFunction)(stripIpServernameFromConnectOptions(options), callback);
}

function createIpSafeProxyClientFactory(): UndiciProxyClientFactory {
  return (origin, options) => {
    // HTTPS proxies addressed by IP can arrive with an IP servername. Strip it
    // before TLS connect because OpenSSL rejects IP literals as SNI values.
    const clientOptions = isObjectRecord(options)
      ? { ...options, connect: stripIpServernameFromConnect(options.connect) }
      : options;
    return createUndiciPool(origin, clientOptions);
  };
}

function createUndiciClient(origin: string | URL, options: object): UndiciDispatcher {
  const { Client } = loadUndiciModule(["Client"]);
  return withUndiciErrorDiagnostics(new Client(origin, options as UndiciClientOptions));
}

function createUndiciPool(origin: string | URL, options: unknown): UndiciDispatcher {
  const { Pool } = loadUndiciModule(["Pool"]);
  const poolOptions = isObjectRecord(options) ? options : {};
  return withUndiciErrorDiagnostics(
    new Pool(origin, {
      ...poolOptions,
      factory: createUndiciClient,
    }),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): UndiciDispatcher {
  return isObjectRecord(options) && options.connections === 1
    ? createUndiciClient(origin, options)
    : createUndiciPool(origin, options);
}

function addUndiciAgentFactory<TOptions extends object>(options: TOptions): TOptions {
  if ("factory" in options) {
    return options;
  }
  return {
    ...options,
    factory: createUndiciOriginDispatcher,
  };
}

function addIpSafeProxyClientFactory<TOptions extends object>(options: TOptions): TOptions {
  if ("clientFactory" in options) {
    return options;
  }
  // Only install our factory when the caller did not provide one, otherwise
  // custom proxy pools would lose their own connection policy.
  return {
    ...options,
    clientFactory: createIpSafeProxyClientFactory(),
  };
}

/** Loads undici lazily, allowing tests to inject constructors without global side effects. */
export function loadUndiciRuntimeDeps(): UndiciRuntimeDeps {
  return loadUndiciModule(["Agent", "EnvHttpProxyAgent", "ProxyAgent", "fetch"]);
}

/** Loads only the undici global-dispatcher API used by startup proxy setup. */
export function loadUndiciGlobalDispatcherDeps(): UndiciGlobalDispatcherDeps {
  return loadUndiciModule([
    "Agent",
    "EnvHttpProxyAgent",
    "getGlobalDispatcher",
    "setGlobalDispatcher",
  ]);
}

function withHttp1OnlyDispatcherOptions<T extends object | undefined>(
  options?: T,
  timeoutMs?: number,
  applyTo?: { connect?: boolean; proxyTls?: boolean },
): (T extends object ? T : Record<never, never>) & { allowH2: false } {
  const base = {} as (T extends object ? T : Record<never, never>) & { allowH2: false };
  if (options) {
    Object.assign(base, options);
  }
  // Enforce HTTP/1.1-only — must come after options to prevent accidental override
  Object.assign(base, HTTP1_ONLY_DISPATCHER_OPTIONS);
  const baseRecord = base as Record<string, unknown>;
  const targets = applyTo ?? { connect: true };
  const autoSelectConnect = resolveUndiciAutoSelectFamilyConnectOptions();
  if (autoSelectConnect && targets.connect && typeof baseRecord.connect !== "function") {
    const connect = isObjectRecord(baseRecord.connect) ? baseRecord.connect : {};
    applyMissingConnectOptions(connect, autoSelectConnect);
    baseRecord.connect = connect;
  }
  if (autoSelectConnect && targets.proxyTls) {
    const proxyTls = isObjectRecord(baseRecord.proxyTls) ? baseRecord.proxyTls : {};
    applyMissingConnectOptions(proxyTls, autoSelectConnect);
    baseRecord.proxyTls = proxyTls;
  }
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    const normalizedTimeoutMs = Math.floor(timeoutMs);
    baseRecord.bodyTimeout = normalizedTimeoutMs;
    baseRecord.headersTimeout = normalizedTimeoutMs;
    if (targets.connect && typeof baseRecord.connect !== "function") {
      baseRecord.connect = {
        ...(isObjectRecord(baseRecord.connect) ? baseRecord.connect : {}),
        timeout: normalizedTimeoutMs,
      };
    }
    if (targets.proxyTls) {
      baseRecord.proxyTls = {
        ...(isObjectRecord(baseRecord.proxyTls) ? baseRecord.proxyTls : {}),
        timeout: normalizedTimeoutMs,
      };
    }
  }
  return base;
}

/** Creates a direct undici Agent with OpenClaw's HTTP/1-only dispatcher policy. */
export function createHttp1Agent(
  options?: UndiciAgentOptions,
  timeoutMs?: number,
): import("undici").Agent {
  const { Agent } = loadUndiciRuntimeDeps();
  return withUndiciErrorDiagnostics(
    new Agent(addUndiciAgentFactory(withHttp1OnlyDispatcherOptions(options, timeoutMs))),
  );
}

/**
 * Creates an EnvHttpProxyAgent with OpenClaw proxy TLS, IP-safe proxy pools,
 * timeout propagation, and HTTP/1-only dispatch.
 */
export function createHttp1EnvHttpProxyAgent(
  options?: UndiciEnvHttpProxyAgentOptions,
  timeoutMs?: number,
): import("undici").EnvHttpProxyAgent {
  const { EnvHttpProxyAgent } = loadUndiciRuntimeDeps();
  return withUndiciErrorDiagnostics(
    new EnvHttpProxyAgent(
      withHttp1OnlyDispatcherOptions(
        addIpSafeProxyClientFactory(
          addUndiciAgentFactory(addActiveManagedProxyTlsOptions(options) ?? {}),
        ),
        timeoutMs,
        {
          connect: true,
          proxyTls: true,
        },
      ),
    ),
  );
}

/**
 * Creates a fixed ProxyAgent with the same HTTP/1, managed TLS, timeout, and
 * IP-safe proxy connection policy used by env proxy dispatchers.
 */
export function createHttp1ProxyAgent(
  options: UndiciProxyAgentOptions,
  timeoutMs?: number,
): import("undici").ProxyAgent {
  const { ProxyAgent } = loadUndiciRuntimeDeps();
  const normalized =
    typeof options === "string" || options instanceof URL
      ? { uri: options.toString() }
      : { ...options };
  return withUndiciErrorDiagnostics(
    new ProxyAgent(
      withHttp1OnlyDispatcherOptions(
        addIpSafeProxyClientFactory(
          addUndiciAgentFactory(addActiveManagedProxyTlsOptions(normalized as object)),
        ),
        timeoutMs,
        {
          proxyTls: true,
        },
      ) as UndiciProxyAgentOptions,
    ),
  );
}
