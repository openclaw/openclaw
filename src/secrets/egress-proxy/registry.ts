import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type {
  SecretEgressProcessGrant,
  SecretEgressProxyHandle,
  SecretEgressSentinelBinding,
} from "./proxy-server.js";
import type { SecretEgressProxyWorkerHandle } from "./proxy-worker.js";

type RegisteredProxy = SecretEgressProxyHandle | SecretEgressProxyWorkerHandle;
type SecretEgressProxyRegistryState = { activeProxy?: RegisteredProxy };
const SECRET_EGRESS_PROXY_REGISTRY_KEY = Symbol.for("openclaw.secretEgressProxy.registry");

function getSecretEgressProxyRegistry(): SecretEgressProxyRegistryState {
  return resolveGlobalSingleton<SecretEgressProxyRegistryState>(
    SECRET_EGRESS_PROXY_REGISTRY_KEY,
    () => ({}),
  );
}

export function publishSecretEgressProxy(proxy: RegisteredProxy): void {
  const registry = getSecretEgressProxyRegistry();
  if (registry.activeProxy) {
    throw new Error("Secret egress proxy is already active in this process");
  }
  registry.activeProxy = proxy;
}

export function clearSecretEgressProxy(proxy: RegisteredProxy): void {
  const registry = getSecretEgressProxyRegistry();
  if (registry.activeProxy === proxy) {
    registry.activeProxy = undefined;
  }
}

export function isSecretEgressProxyActive(): boolean {
  return getSecretEgressProxyRegistry().activeProxy !== undefined;
}

/** Reads current certificate health without reloading trust files or starting a proxy. */
export function getSecretEgressCertificateStatus() {
  return getSecretEgressProxyRegistry().activeProxy?.getCertificateStatus();
}

const LOOPBACK_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Overlays a process grant on its child environment. The proxy refuses plain HTTP,
 * so loopback servers stay direct instead of failing; existing bypass entries keep
 * their direct route.
 */
export function applySecretEgressProcessEnv(
  env: NodeJS.ProcessEnv | undefined,
  grant: SecretEgressProcessGrant,
): NodeJS.ProcessEnv {
  const noProxy = new Set<string>();
  for (const entry of `${env?.NO_PROXY ?? ""},${env?.no_proxy ?? ""}`.split(",")) {
    if (entry.trim()) {
      noProxy.add(entry.trim());
    }
  }
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    noProxy.add(host);
  }
  const value = [...noProxy].join(",");
  return { ...env, ...grant.env, NO_PROXY: value, no_proxy: value };
}

/** The exec supervisor owns this grant until cancellation or process exit. */
export function registerSecretEgressProxyProcess(bindings: readonly SecretEgressSentinelBinding[]) {
  const proxy = getSecretEgressProxyRegistry().activeProxy;
  if (!proxy) {
    throw new Error("Secret egress proxy is not active in this Gateway process");
  }
  return proxy.registerProcess(bindings);
}
