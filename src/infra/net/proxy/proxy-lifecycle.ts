import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { isHttpUrl, isWebSocketUrl } from "@openclaw/net-policy/url-protocol";
// Managed proxy lifecycle installs Proxyline, injects process proxy env, and
// restores inherited/direct routing when owner handles stop.
import {
  installGlobalProxy,
  type ProxylineBypassPolicy,
  type ProxylineHandle,
  type ProxylineUndiciOptions,
} from "@openclaw/proxyline";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import { logInfo, logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import {
  getActiveManagedProxyLoopbackMode,
  getActiveManagedProxyUrl,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
  type ActiveManagedProxyRegistration,
} from "./active-proxy-state.js";
import {
  loadManagedProxyTlsOptions,
  loadManagedProxyTlsOptionsSync,
  resolveManagedProxyCaFileForUrl,
} from "./proxy-tls.js";

type ProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;

/** Process-wide managed proxy handle returned to CLI/gateway startup owners. */
export type ProxyHandle = {
  /** The operator-managed proxy URL injected into process.env. */
  proxyUrl: string;
  /** Restore process-wide proxy state. */
  stop: () => Promise<void>;
  /** Synchronously restore process-wide proxy state during hard process exit. */
  kill: (signal?: NodeJS.Signals) => void;
};

const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY"] as const;
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,localhost.,::1,[::1],127.0.0.0/8";
const managedLoopbackBypassPolicy: ProxylineBypassPolicy = ({ url }) =>
  getActiveManagedProxyLoopbackMode() === "gateway-only" && isLoopbackProxyUrl(url);
const PROXY_ACTIVE_KEYS = [
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_LOOPBACK_MODE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const ALL_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, ...NO_PROXY_ENV_KEYS, ...PROXY_ACTIVE_KEYS] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

let baseProxyEnvSnapshot: ProxyEnvSnapshot | null = null;
let proxylineHandle: ProxylineHandle | null = null;
const MANAGED_PROXY_UNDICI_OPTIONS = Object.freeze({
  allowH2: false,
}) satisfies ProxylineUndiciOptions;

/** Resets process-wide proxy lifecycle state between tests that share a worker. */
export function resetProxyLifecycleForTests(): void {
  baseProxyEnvSnapshot = null;
  proxylineHandle?.stop();
  proxylineHandle = null;
}

function captureProxyEnv(): ProxyEnvSnapshot {
  return {
    http_proxy: process.env["http_proxy"],
    https_proxy: process.env["https_proxy"],
    HTTP_PROXY: process.env["HTTP_PROXY"],
    HTTPS_PROXY: process.env["HTTPS_PROXY"],
    no_proxy: process.env["no_proxy"],
    NO_PROXY: process.env["NO_PROXY"],
    OPENCLAW_PROXY_ACTIVE: process.env["OPENCLAW_PROXY_ACTIVE"],
    OPENCLAW_PROXY_LOOPBACK_MODE: process.env["OPENCLAW_PROXY_LOOPBACK_MODE"],
    OPENCLAW_PROXY_CA_FILE: process.env["OPENCLAW_PROXY_CA_FILE"],
  };
}

function injectProxyEnv(
  proxyUrl: string,
  loopbackMode: ProxyLoopbackMode,
  proxyCaFile: string | undefined,
): ProxyEnvSnapshot {
  const snapshot = captureProxyEnv();
  applyProxyEnv(proxyUrl, loopbackMode, proxyCaFile);
  return snapshot;
}

function applyProxyEnv(
  proxyUrl: string,
  loopbackMode: ProxyLoopbackMode,
  proxyCaFile: string | undefined,
): void {
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
  process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = loopbackMode;
  if (proxyCaFile) {
    process.env["OPENCLAW_PROXY_CA_FILE"] = proxyCaFile;
  } else {
    delete process.env["OPENCLAW_PROXY_CA_FILE"];
  }
  for (const key of NO_PROXY_ENV_KEYS) {
    process.env[key] = loopbackMode === "gateway-only" ? LOOPBACK_NO_PROXY : "";
  }
}

function restoreProxyEnv(snapshot: ProxyEnvSnapshot): void {
  for (const key of ALL_PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreInactiveProxyRuntime(snapshot: ProxyEnvSnapshot): void {
  try {
    proxylineHandle?.stop();
  } catch (err) {
    logWarn(`proxy: failed to stop Proxyline: ${String(err)}`);
  }
  proxylineHandle = null;
  restoreProxyEnv(snapshot);
  forceResetGlobalDispatcher();
  // If this process itself is a child of an active managed proxy, restoring the
  // local lifecycle should keep inherited proxy routing active.
  ensureInheritedManagedProxyRoutingActive();
}

function restoreAfterFailedProxyActivation(restoreSnapshot: ProxyEnvSnapshot): void {
  restoreInactiveProxyRuntime(restoreSnapshot);
  baseProxyEnvSnapshot = null;
}

function stopActiveProxyRegistration(registration: ActiveManagedProxyRegistration): void {
  if (registration.stopped) {
    return;
  }
  stopActiveManagedProxyRegistration(registration);
  if (getActiveManagedProxyUrl()) {
    return;
  }

  const restoreSnapshot = baseProxyEnvSnapshot ?? captureProxyEnv();
  baseProxyEnvSnapshot = null;
  restoreInactiveProxyRuntime(restoreSnapshot);
}

function resolveProxyUrl(config: ProxyConfig | undefined): string {
  const candidate = config?.proxyUrl?.trim() || process.env["OPENCLAW_PROXY_URL"]?.trim();
  if (!candidate) {
    throw new Error(
      "proxy: enabled but no HTTP proxy URL is configured; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// or https:// forward proxy.",
    );
  }
  if (!isHttpUrl(candidate)) {
    throw new Error(
      "proxy: enabled but proxy URL is invalid; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// or https:// forward proxy.",
    );
  }
  return candidate;
}

function redactProxyUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return "<invalid proxy URL>";
  }
}

/** Reinstalls Proxyline routing in child processes that inherited active proxy env. */
export function ensureInheritedManagedProxyRoutingActive(): void {
  if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return;
  }
  const proxyUrl = process.env["HTTP_PROXY"];
  if (!proxyUrl || !isHttpUrl(proxyUrl)) {
    return;
  }
  const proxyCaFile = resolveManagedProxyCaFileForUrl({
    proxyUrl,
    caFileOverride: process.env["OPENCLAW_PROXY_CA_FILE"],
  });
  const proxyTls = loadManagedProxyTlsOptionsSync(proxyCaFile);
  applyProxyEnv(proxyUrl, getActiveManagedProxyLoopbackMode() ?? "gateway-only", proxyCaFile);
  proxylineHandle = installGlobalProxy({
    mode: "managed",
    proxyUrl,
    ...(proxyTls ? { proxyTls } : {}),
    ifActive: "reuse-compatible",
    bypassPolicy: managedLoopbackBypassPolicy,
    undici: MANAGED_PROXY_UNDICI_OPTIONS,
  });
  forceResetGlobalDispatcher({ preserveProxylineManaged: true });
}

/** Starts process-wide managed proxy routing and returns the owner stop handle. */
export async function startProxy(config: ProxyConfig | undefined): Promise<ProxyHandle | null> {
  if (
    config?.enabled === false ||
    (!config?.proxyUrl?.trim() && !process.env["OPENCLAW_PROXY_URL"]?.trim())
  ) {
    return null;
  }

  const proxyUrl = resolveProxyUrl(config);
  const loopbackMode = config?.loopbackMode ?? "gateway-only";
  const proxyCaFile = resolveManagedProxyCaFileForUrl({ proxyUrl, config });
  const proxyTls = await loadManagedProxyTlsOptions(proxyCaFile);
  const activeProxyUrl = getActiveManagedProxyUrl();
  if (activeProxyUrl) {
    // Nested starts share the existing process-wide proxy when URL, loopback
    // mode, and TLS options match; each caller still receives its own handle.
    const registration = registerActiveManagedProxyUrl(new URL(proxyUrl), {
      loopbackMode,
      proxyTls,
    });
    const handle: ProxyHandle = {
      proxyUrl,
      stop: async () => {
        stopActiveProxyRegistration(registration);
      },
      kill: () => {
        stopActiveProxyRegistration(registration);
      },
    };
    return handle;
  }
  baseProxyEnvSnapshot ??= captureProxyEnv();
  const lifecycleBaseEnvSnapshot = baseProxyEnvSnapshot;
  let registration: ActiveManagedProxyRegistration | null = null;

  try {
    injectProxyEnv(proxyUrl, loopbackMode, proxyCaFile);
    proxylineHandle = installGlobalProxy({
      mode: "managed",
      proxyUrl,
      ...(proxyTls ? { proxyTls } : {}),
      ifActive: "replace",
      bypassPolicy: managedLoopbackBypassPolicy,
      undici: MANAGED_PROXY_UNDICI_OPTIONS,
    });
    forceResetGlobalDispatcher({ preserveProxylineManaged: true });
    registration = registerActiveManagedProxyUrl(new URL(proxyUrl), {
      loopbackMode,
      proxyTls,
    });
  } catch (err) {
    if (registration) {
      stopActiveManagedProxyRegistration(registration);
    }
    restoreAfterFailedProxyActivation(lifecycleBaseEnvSnapshot);
    throw new Error(`proxy: failed to activate external proxy routing: ${String(err)}`, {
      cause: err,
    });
  }

  logInfo(
    `proxy: routing process HTTP traffic through external proxy ${redactProxyUrlForLog(proxyUrl)}`,
  );

  const handle: ProxyHandle = {
    proxyUrl,
    stop: async () => {
      if (registration) {
        stopActiveProxyRegistration(registration);
      }
    },
    kill: () => {
      if (registration) {
        stopActiveProxyRegistration(registration);
      }
    },
  };

  return handle;
}

/** Stops a managed proxy handle if one was started. */
export async function stopProxy(handle: ProxyHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  await handle.stop();
}

function isLoopbackProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    return (
      (isHttpUrl(url) || isWebSocketUrl(url)) &&
      (hostname === "localhost" || isLoopbackIpAddress(hostname))
    );
  } catch {
    return false;
  }
}

function assertManagedProxyAllowsLoopback(url: string, surface: string): void {
  if (isLoopbackProxyUrl(url) && getActiveManagedProxyLoopbackMode() === "block") {
    throw new Error(
      `proxy: ${surface} connections are blocked by proxy.loopbackMode; ` +
        "run openclaw config set proxy.loopbackMode gateway-only to allow local runtime traffic.",
    );
  }
}

// Keep the existing Gateway client and plugin SDK callback contracts for explicit
// block policy. Default loopback routing no longer needs per-request registration.
export function registerManagedProxyGatewayLoopbackBypass(url: string): (() => void) | undefined {
  assertManagedProxyAllowsLoopback(url, "Gateway loopback control-plane");
  return undefined;
}

export function registerManagedProxyBrowserCdpBypass(url: string): (() => void) | undefined {
  assertManagedProxyAllowsLoopback(url, "Browser loopback CDP");
  return undefined;
}
