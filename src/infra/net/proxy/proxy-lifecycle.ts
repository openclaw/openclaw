/**
 * High-level lifecycle management for OpenClaw's operator-managed network
 * proxy routing.
 *
 * OpenClaw does not spawn or configure the filtering proxy. When enabled, it
 * routes process-wide HTTP clients through the configured forward proxy URL and
 * restores the previous process state on shutdown.
 */

import { isIP } from "node:net";
import { installGlobalProxy, type ProxylineHandle } from "@jesse-merhi/proxyline";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";

export type ProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;
import { logInfo, logWarn } from "../../../logger.js";
import { isLoopbackIpAddress } from "../../../shared/net/ip.js";
import {
  getActiveManagedProxyLoopbackMode,
  getActiveManagedProxyUrl,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
  type ActiveManagedProxyRegistration,
} from "./active-proxy-state.js";

export type ProxyHandle = {
  /** The operator-managed proxy URL injected into process.env. */
  proxyUrl: string;
  /** Alias kept for CLI cleanup tests and logs. */
  injectedProxyUrl: string;
  /** Original proxy-related environment values, restored on stop/crash. */
  envSnapshot: ProxyEnvSnapshot;
  /** Restore process-wide proxy state. */
  stop: () => Promise<void>;
  /** Synchronously restore process-wide proxy state during hard process exit. */
  kill: (signal?: NodeJS.Signals) => void;
};

const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY"] as const;
const PROXY_ACTIVE_KEYS = ["OPENCLAW_PROXY_ACTIVE", "OPENCLAW_PROXY_LOOPBACK_MODE"] as const;
const ALL_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, ...NO_PROXY_ENV_KEYS, ...PROXY_ACTIVE_KEYS] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

let baseProxyEnvSnapshot: ProxyEnvSnapshot | null = null;
let proxylineHandle: ProxylineHandle | null = null;

export function _resetGlobalAgentBootstrapForTests(): void {
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
  };
}

function injectProxyEnv(proxyUrl: string, loopbackMode: ProxyLoopbackMode): ProxyEnvSnapshot {
  const snapshot = captureProxyEnv();
  applyProxyEnv(proxyUrl, loopbackMode);
  return snapshot;
}

function applyProxyEnv(proxyUrl: string, loopbackMode: ProxyLoopbackMode): void {
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  process.env["OPENCLAW_PROXY_ACTIVE"] = "1";
  process.env["OPENCLAW_PROXY_LOOPBACK_MODE"] = loopbackMode;
  for (const key of NO_PROXY_ENV_KEYS) {
    process.env[key] = "";
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

function isSupportedProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:";
  } catch {
    return false;
  }
}

function resolveProxyUrl(config: ProxyConfig | undefined): string {
  const candidate = config?.proxyUrl?.trim() || process.env["OPENCLAW_PROXY_URL"]?.trim();
  if (!candidate) {
    throw new Error(
      "proxy: enabled but no HTTP proxy URL is configured; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// forward proxy.",
    );
  }
  if (!isSupportedProxyUrl(candidate)) {
    throw new Error(
      "proxy: enabled but proxy URL is invalid; set proxy.proxyUrl " +
        "or OPENCLAW_PROXY_URL to an http:// forward proxy.",
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

export function ensureInheritedManagedProxyRoutingActive(): void {
  if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return;
  }
  const proxyUrl = process.env["HTTP_PROXY"];
  if (!proxyUrl || !isSupportedProxyUrl(proxyUrl)) {
    return;
  }
  proxylineHandle ??= installGlobalProxy({ mode: "managed", proxyUrl });
}

export async function startProxy(config: ProxyConfig | undefined): Promise<ProxyHandle | null> {
  if (config?.enabled !== true) {
    return null;
  }

  const proxyUrl = resolveProxyUrl(config);
  const loopbackMode = config.loopbackMode ?? "gateway-only";
  const activeProxyUrl = getActiveManagedProxyUrl();
  if (activeProxyUrl) {
    const registration = registerActiveManagedProxyUrl(new URL(proxyUrl), loopbackMode);
    const handle: ProxyHandle = {
      proxyUrl,
      injectedProxyUrl: proxyUrl,
      envSnapshot: baseProxyEnvSnapshot ?? captureProxyEnv(),
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
  let injectedEnvSnapshot = captureProxyEnv();
  let registration: ActiveManagedProxyRegistration | null = null;

  try {
    injectedEnvSnapshot = injectProxyEnv(proxyUrl, loopbackMode);
    proxylineHandle ??= installGlobalProxy({ mode: "managed", proxyUrl });
    registration = registerActiveManagedProxyUrl(new URL(proxyUrl), loopbackMode);
  } catch (err) {
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
    injectedProxyUrl: proxyUrl,
    envSnapshot: injectedEnvSnapshot,
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

export async function stopProxy(handle: ProxyHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  await handle.stop();
}

function parseGatewayControlPlaneUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isGatewayControlPlaneProtocol(protocol: string): boolean {
  return protocol === "ws:" || protocol === "wss:" || protocol === "http:" || protocol === "https:";
}

function getGatewayControlPlaneNoProxyAuthority(value: string): string | null {
  const url = parseGatewayControlPlaneUrl(value);
  if (
    url === null ||
    !isGatewayControlPlaneProtocol(url.protocol) ||
    !isGatewayControlPlaneLoopbackHost(url.hostname)
  ) {
    return null;
  }
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

function unbracketHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isGatewayControlPlaneIpv6LoopbackUrl(value: string): boolean {
  const url = parseGatewayControlPlaneUrl(value);
  if (
    url === null ||
    !isGatewayControlPlaneProtocol(url.protocol) ||
    !isGatewayControlPlaneLoopbackHost(url.hostname)
  ) {
    return false;
  }
  return isIP(unbracketHost(url.hostname)) === 6;
}

function readGlobalAgentNoProxy(): string {
  return process.env["NO_PROXY"] ?? "";
}

function writeGlobalAgentNoProxy(value: string): void {
  if (value === "") {
    process.env["NO_PROXY"] = "";
    process.env["no_proxy"] = "";
  } else {
    process.env["NO_PROXY"] = value;
    process.env["no_proxy"] = value;
  }
}

function appendNoProxyAuthority(noProxy: string, authority: string): string {
  const entries = noProxy.split(/[\s,]+/).filter(Boolean);
  return entries.includes(authority) ? noProxy : [...entries, authority].join(",");
}

function disableGlobalAgentProxyForIpv6GatewayLoopback(url: string): (() => void) | undefined {
  void url;
  return undefined;
}

export function registerManagedProxyGatewayLoopbackNoProxy(url: string): (() => void) | undefined {
  const authority = getGatewayControlPlaneNoProxyAuthority(url);
  if (!authority) {
    return undefined;
  }
  const loopbackMode = getActiveManagedProxyLoopbackMode();
  if (loopbackMode === "block") {
    throw new Error(
      "proxy: Gateway loopback control-plane connections are blocked by proxy.loopbackMode",
    );
  }
  if (loopbackMode === "proxy") {
    return undefined;
  }

  const previousNoProxy = readGlobalAgentNoProxy();
  writeGlobalAgentNoProxy(appendNoProxyAuthority(previousNoProxy, authority));
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    writeGlobalAgentNoProxy(previousNoProxy);
  };
}

export function withManagedProxyGatewayLoopbackRouting<T>(url: string, run: () => T): T {
  let unregisterNoProxy: (() => void) | undefined;
  let restoreIpv6Bypass: (() => void) | undefined;
  try {
    unregisterNoProxy = registerManagedProxyGatewayLoopbackNoProxy(url);
    restoreIpv6Bypass = disableGlobalAgentProxyForIpv6GatewayLoopback(url);
    return run();
  } finally {
    restoreIpv6Bypass?.();
    unregisterNoProxy?.();
  }
}

function isGatewayControlPlaneLoopbackHost(hostname: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return normalizedHost === "localhost" || isLoopbackIpAddress(hostname);
}
