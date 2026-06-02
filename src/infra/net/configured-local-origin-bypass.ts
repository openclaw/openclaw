import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { getActiveManagedProxyLoopbackMode } from "./proxy/active-proxy-state.js";
import { SsrFBlockedError } from "./ssrf.js";

export type ConfiguredLocalOriginManagedProxyBypass = {
  kind: "configured-local-origin";
  baseUrl: string;
};

/** Resolve only HTTP/S origins, normalizing trailing DNS dots before exact comparison. */
function resolveHttpOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Accept only localhost or loopback IP literals for the managed-proxy bypass host. */
function isLoopbackManagedProxyBypassHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || isLoopbackIpAddress(normalized);
}

/** Match the configured local provider origin exactly before allowing a proxy bypass. */
function isExactConfiguredLocalOriginBypass(params: {
  url: URL;
  managedProxyBypass: ConfiguredLocalOriginManagedProxyBypass | undefined;
}): boolean {
  if (params.managedProxyBypass?.kind !== "configured-local-origin") {
    return false;
  }
  const baseOrigin = resolveHttpOrigin(params.managedProxyBypass.baseUrl);
  if (!baseOrigin) {
    return false;
  }
  let baseHostname: string;
  try {
    baseHostname = new URL(params.managedProxyBypass.baseUrl.trim()).hostname;
  } catch {
    return false;
  }
  if (!isLoopbackManagedProxyBypassHost(baseHostname)) {
    return false;
  }
  return resolveHttpOrigin(params.url.toString()) === baseOrigin;
}

/** Require every resolved address to stay loopback so DNS rebinding cannot escape. */
function isPinnedLoopbackTarget(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every((address) => isLoopbackIpAddress(address));
}

/**
 * Decide whether a configured local provider may bypass the managed proxy.
 * The bypass is origin-exact, loopback-pinned, and still honors active loopback mode.
 */
export function shouldUseConfiguredLocalOriginManagedProxyBypass(params: {
  url: URL;
  managedProxyBypass: ConfiguredLocalOriginManagedProxyBypass | undefined;
  resolvedAddresses: readonly string[];
}): boolean {
  if (!isExactConfiguredLocalOriginBypass(params)) {
    return false;
  }
  const loopbackMode = getActiveManagedProxyLoopbackMode();
  if (loopbackMode === "proxy") {
    return false;
  }
  if (loopbackMode === "block" && isLoopbackManagedProxyBypassHost(params.url.hostname)) {
    throw new SsrFBlockedError(
      "proxy: configured local provider loopback connections are blocked by proxy.loopbackMode",
    );
  }
  return isPinnedLoopbackTarget(params.resolvedAddresses);
}
