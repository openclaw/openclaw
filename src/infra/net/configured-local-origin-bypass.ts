// Configured local-origin bypass logic decides when managed proxy routing may
// skip proxying a known loopback provider origin, and which host-granted
// address exemptions apply to that exact origin.
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { normalizeHostname } from "./hostname.js";
import { getActiveManagedProxyLoopbackMode } from "./proxy/active-proxy-state.js";
import { withTrustedHostPodmanGatewayLinkLocalExemption } from "./ssrf-trusted-host-linklocal-exemptions.js";
import { SsrFBlockedError, type SsrFPolicy } from "./ssrf.js";

// Configured local-origin bypass allows managed proxy calls to skip proxying
// only when config, DNS, and active loopback policy all prove a loopback target.
export type ConfiguredLocalOriginManagedProxyBypass = {
  kind: "configured-local-origin";
  baseUrl: string;
  /** Grant link-local DNS only to the exact configured host.containers.internal origin. */
  allowPodmanHostGatewayLinkLocal?: boolean;
};

function parseHttpUrl(value: string): URL | undefined {
  const parsed = URL.parse(value.trim());
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return undefined;
  }
  parsed.hostname = parsed.hostname.replace(/\.+$/, "");
  return parsed;
}

function isLoopbackManagedProxyBypassHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || isLoopbackIpAddress(normalized);
}

/** Return whether proving a configured local-origin bypass requires target DNS. */
export function shouldResolveConfiguredLocalOriginManagedProxyBypass(params: {
  url: URL;
  managedProxyBypass: ConfiguredLocalOriginManagedProxyBypass | undefined;
}): boolean {
  if (params.managedProxyBypass?.kind !== "configured-local-origin") {
    return false;
  }
  const baseUrl = parseHttpUrl(params.managedProxyBypass.baseUrl);
  if (!baseUrl || !isLoopbackManagedProxyBypassHost(baseUrl.hostname)) {
    return false;
  }
  return parseHttpUrl(params.url.toString())?.origin.toLowerCase() === baseUrl.origin.toLowerCase();
}

/** Return whether a configured local provider origin may bypass the managed proxy. */
export function shouldUseConfiguredLocalOriginManagedProxyBypass(params: {
  url: URL;
  managedProxyBypass: ConfiguredLocalOriginManagedProxyBypass | undefined;
  resolvedAddresses: readonly string[];
}): boolean {
  if (!shouldResolveConfiguredLocalOriginManagedProxyBypass(params)) {
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
  return (
    params.resolvedAddresses.length > 0 &&
    params.resolvedAddresses.every((address) => isLoopbackIpAddress(address))
  );
}

/** Derive the host-only grant independently for each exact-origin hop. */
export function resolveConfiguredLocalOriginLinkLocalHopPolicy(params: {
  url: URL;
  policy: SsrFPolicy | undefined;
  managedProxyBypass: ConfiguredLocalOriginManagedProxyBypass | undefined;
}): SsrFPolicy | undefined {
  const { policy, managedProxyBypass } = params;
  if (!policy || managedProxyBypass?.allowPodmanHostGatewayLinkLocal !== true) {
    return policy;
  }
  const baseUrl = parseHttpUrl(managedProxyBypass.baseUrl);
  if (
    baseUrl?.hostname !== "host.containers.internal" ||
    parseHttpUrl(params.url.href)?.origin !== baseUrl.origin
  ) {
    return policy;
  }
  return withTrustedHostPodmanGatewayLinkLocalExemption(policy);
}
