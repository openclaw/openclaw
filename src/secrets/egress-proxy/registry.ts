import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SecretEgressProxyHandle, SecretEgressSentinelBinding } from "./proxy-server.js";
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

/** The exec supervisor owns this grant until cancellation or process exit. */
export function registerSecretEgressProxyProcess(bindings: readonly SecretEgressSentinelBinding[]) {
  const proxy = getSecretEgressProxyRegistry().activeProxy;
  if (!proxy) {
    throw new Error("Secret egress proxy is not active in this Gateway process");
  }
  return proxy.registerProcess(bindings);
}
