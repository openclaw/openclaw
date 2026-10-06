// Gateway network address helpers.
// Normalizes host/IP inputs and classifies local/private gateway requests.
import type { IncomingMessage } from "node:http";
import net from "node:net";
import os from "node:os";
import {
  isCanonicalDottedDecimalIPv4,
  isIpInCidr,
  isLoopbackIpAddress,
  isPrivateOrLoopbackIpAddress,
  isRfc8215LocalUseNat64Ipv6Address,
  normalizeIpAddress,
} from "@openclaw/net-policy/ip";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseHostForAddressChecks } from "../../packages/gateway-client/src/client-address-utils.js";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { isContainerEnvironment } from "../infra/container-environment.js";
import {
  pickMatchingExternalInterfaceAddress,
  safeNetworkInterfaces,
  type NetworkInterfacesSnapshot,
} from "../infra/network-interfaces.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { firstHeaderValue } from "./http-header-value.js";
import { normalizeWebSocketProtocol } from "./websocket-protocol.js";

/** Pick the primary non-internal IPv4 address, preferring common LAN interface names. */
export function pickPrimaryLanIPv4(): string | undefined {
  return pickMatchingExternalInterfaceAddress(os.networkInterfaces(), {
    family: "IPv4",
    preferredNames: ["en0", "eth0"],
  });
}

/** Normalize a raw Host header for gateway origin and local-request checks. */
export function normalizeHostHeader(hostHeader?: string): string {
  return normalizeLowercaseStringOrEmpty(hostHeader);
}

/** Extract hostname from a Host header while preserving unbracketed IPv6 hosts. */
export function resolveHostName(hostHeader?: string): string {
  const host = normalizeHostHeader(hostHeader);
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      return host.slice(1, end);
    }
  }
  // Unbracketed IPv6 host (e.g. "::1") has no port and should be returned as-is.
  if (net.isIP(host) === 6) {
    return host;
  }
  const [name] = host.split(":");
  return name ?? "";
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  return isLoopbackIpAddress(ip);
}

/** Detect forwarded/proxy headers that make loopback requests ineligible for direct-local auth. */
export function hasForwardedRequestHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  const headers = req.headers ?? {};
  return Object.keys(headers).some((header) => {
    const normalized = normalizeLowercaseStringOrEmpty(header);
    return (
      normalized === "forwarded" ||
      normalized === "x-real-ip" ||
      normalized.startsWith("x-forwarded-")
    );
  });
}

/** Return whether a request is a clean loopback request without forwarded identity headers. */
export function isLocalDirectRequest(req?: IncomingMessage): boolean {
  return Boolean(
    req && !hasForwardedRequestHeaders(req) && isLoopbackAddress(req.socket?.remoteAddress),
  );
}

export function resolveLocalInterfaceAddressMatch(
  ip: string | undefined,
  snapshot?: NetworkInterfacesSnapshot,
): boolean | undefined {
  const normalized = normalizeIpAddress(ip);
  if (!normalized) {
    return false;
  }
  const effectiveSnapshot = arguments.length >= 2 ? snapshot : safeNetworkInterfaces();
  if (!effectiveSnapshot) {
    return undefined;
  }

  for (const entries of Object.values(effectiveSnapshot)) {
    for (const entry of entries ?? []) {
      if (normalizeIpAddress(entry.address) === normalized) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns true if the IP belongs to a private or loopback network range.
 * Private ranges: RFC1918, link-local, ULA IPv6, and CGNAT (100.64/10), plus loopback.
 * Excludes RFC8215 local-use NAT64: SSRF policy blocks that allocation, but
 * Gateway trust decisions cannot infer a private mapped destination from it.
 */
export function isPrivateOrLoopbackAddress(ip: string | undefined): boolean {
  return isPrivateOrLoopbackIpAddress(ip) && !isRfc8215LocalUseNat64Ipv6Address(ip);
}

function stripOptionalPort(ip: string): string {
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end !== -1) {
      return ip.slice(1, end);
    }
  }
  if (net.isIP(ip)) {
    return ip;
  }
  const lastColon = ip.lastIndexOf(":");
  if (lastColon > -1 && ip.includes(".") && ip.indexOf(":") === lastColon) {
    const candidate = ip.slice(0, lastColon);
    if (net.isIP(candidate) === 4) {
      return candidate;
    }
  }
  return ip;
}

function parseIpLiteral(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = stripOptionalPort(trimmed);
  const normalized = normalizeIpAddress(stripped);
  if (!normalized || net.isIP(normalized) === 0) {
    return undefined;
  }
  return normalized;
}

function resolveForwardedClientIp(params: {
  forwardedFor?: string;
  trustedProxies?: string[];
}): string | undefined {
  const { forwardedFor, trustedProxies } = params;
  if (!trustedProxies?.length) {
    return undefined;
  }

  const forwardedChain: string[] = [];
  for (const entry of forwardedFor?.split(",") ?? []) {
    const normalized = parseIpLiteral(entry);
    if (normalized) {
      forwardedChain.push(normalized);
    }
  }
  if (forwardedChain.length === 0) {
    return undefined;
  }

  // Walk right-to-left and return the first untrusted hop.
  for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
    const hop = forwardedChain[index];
    if (isLoopbackAddress(hop)) {
      continue;
    }
    if (!isTrustedProxyAddress(hop, trustedProxies)) {
      return hop;
    }
  }
  return undefined;
}

export function isTrustedProxyAddress(ip: string | undefined, trustedProxies?: string[]): boolean {
  const normalized = normalizeIpAddress(ip);
  if (!normalized || !trustedProxies || trustedProxies.length === 0) {
    return false;
  }

  return trustedProxies.some((proxy) => {
    const candidate = proxy.trim();
    if (!candidate) {
      return false;
    }
    return isIpInCidr(normalized, candidate);
  });
}

export function resolveClientIp(params: {
  remoteAddr?: string;
  forwardedFor?: string;
  realIp?: string;
  trustedProxies?: string[];
  /** Default false: only trust X-Real-IP when explicitly enabled. */
  allowRealIpFallback?: boolean;
}): string | undefined {
  const remote = normalizeIpAddress(params.remoteAddr);
  if (!remote) {
    return undefined;
  }
  if (!isTrustedProxyAddress(remote, params.trustedProxies)) {
    return remote;
  }
  // Fail closed when traffic comes from a trusted proxy but client-origin headers
  // are missing or invalid. Falling back to the proxy's own IP can accidentally
  // treat unrelated requests as local/trusted.
  const forwardedIp = resolveForwardedClientIp({
    forwardedFor: params.forwardedFor,
    trustedProxies: params.trustedProxies,
  });
  if (forwardedIp) {
    return forwardedIp;
  }
  if (params.allowRealIpFallback) {
    return parseIpLiteral(params.realIp);
  }
  return undefined;
}

export function resolveRequestClientIpFromHeaders(
  req?: IncomingMessage,
  trustedProxies?: string[],
  allowRealIpFallback = false,
): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: firstHeaderValue(req.headers?.["x-forwarded-for"]),
    realIp: firstHeaderValue(req.headers?.["x-real-ip"]),
    trustedProxies,
    allowRealIpFallback,
  });
}

export { isContainerEnvironment };

/** Resolve the requested bind host; startup validates unavailable custom addresses. */
export async function resolveGatewayBindHost(
  bind: GatewayBindMode | undefined,
  customHost?: string,
): Promise<string> {
  const mode = bind ?? "loopback";

  if (mode === "loopback") {
    return "127.0.0.1";
  }

  if (mode === "tailnet") {
    const tailnetIP = pickPrimaryTailnetIPv4();
    if (tailnetIP && (await canBindToHost(tailnetIP))) {
      return tailnetIP;
    }
  }
  // Container auto mode needs all interfaces for host port-forwarding. Other
  // auto/tailnet fallbacks prefer loopback when it is available.
  if (mode === "tailnet" || (mode === "auto" && !isContainerEnvironment())) {
    return (await canBindToHost("127.0.0.1")) ? "127.0.0.1" : "0.0.0.0";
  }
  if (mode === "custom") {
    const host = customHost?.trim();
    if (host && isValidIPv4(host) && (await canBindToHost(host))) {
      return host;
    }
    // Runtime startup rejects this fallback; status/display callers remain best-effort.
  }

  return "0.0.0.0";
}

/**
 * Returns the effective default bind mode when `gateway.bind` is not explicitly
 * configured. Inside a detected container environment the default is `"auto"`
 * (which resolves to `0.0.0.0` for port-forwarding compatibility); on bare-metal
 * / VM hosts the default remains `"loopback"`.
 *
 * When {@link tailscaleMode} is `"serve"` or `"funnel"`, the function always
 * returns `"loopback"` because Tailscale serve/funnel architecturally requires
 * a loopback bind — container auto-detection must never override this.
 *
 * Use this only in gateway startup codepaths that execute in the same
 * environment as the eventual bind decision. Host-side diagnostics should keep
 * their own explicit defaults instead of inferring from the caller process.
 */
export function defaultGatewayBindMode(tailscaleMode?: string): GatewayBindMode {
  if (tailscaleMode && tailscaleMode !== "off") {
    return "loopback";
  }
  return isContainerEnvironment() ? "auto" : "loopback";
}

async function canBindToHost(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = net.createServer();
    const timeout = setTimeout(() => finish(false), 3000);
    const finish = (canBind: boolean) => {
      clearTimeout(timeout);
      testServer.close();
      resolve(canBind);
    };
    testServer.once("error", () => finish(false));
    // Keep this handler after timeout: a late bind must still close its socket.
    // Promise settlement is one-shot, so late events cannot change the result.
    testServer.once("listening", () => finish(true));
    try {
      testServer.listen(0, host);
    } catch {
      finish(false);
    }
  });
}

export async function resolveGatewayListenHosts(
  bindHost: string,
  opts?: { canBindToHost?: (host: string) => Promise<boolean> },
): Promise<string[]> {
  const requiredHosts = resolveGatewayRequiredListenHosts(bindHost);
  if (bindHost !== "127.0.0.1") {
    return requiredHosts;
  }
  // Windows: uv_tcp_bind6 creates a dual-stack socket (no UV_TCP_IPV6ONLY), which
  // also accepts ::ffff:127.0.0.1 connections. Binding both ::1 and 127.0.0.1 on
  // the same port causes non-deterministic TCP routing → HTTP requests hang silently.
  if (process.platform === "win32") {
    return [bindHost];
  }
  const canBind = opts?.canBindToHost ?? canBindToHost;
  if (await canBind("::1")) {
    return [bindHost, "::1"];
  }
  return [bindHost];
}

/** Returns every address whose bind must succeed for Gateway startup to succeed. */
export function resolveGatewayRequiredListenHosts(bindHost: string): string[] {
  if (!isValidIPv4(bindHost) || bindHost === "0.0.0.0" || bindHost === "127.0.0.1") {
    return [bindHost];
  }
  // Same-host clients use the canonical loopback URL even when external access is
  // pinned to one interface. Lifecycle checks must therefore cover both listeners.
  return [bindHost, "127.0.0.1"];
}

export function isValidIPv4(host: string): boolean {
  return isCanonicalDottedDecimalIPv4(host);
}

/**
 * Check if a hostname or IP refers to the local machine.
 * Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
 * Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
 */
export function isLoopbackHost(host: string): boolean {
  const parsed = typeof host === "string" ? parseHostForAddressChecks(host) : null;
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  return isLoopbackAddress(parsed.unbracketedHost);
}

// Gateway-local policy rejects dotted localhost and intentionally allows any URL scheme.
export function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

/**
 * Local-facing host check for inbound requests:
 * - loopback hosts (localhost/127.x/::1 and mapped forms)
 * - Tailscale Serve/Funnel hostnames (*.ts.net)
 */
export function isLocalishHost(hostHeader?: string): boolean {
  const host = resolveHostName(hostHeader);
  if (!host) {
    return false;
  }
  return isLoopbackHost(host) || host.endsWith(".ts.net");
}

/**
 * Check if a hostname or IP refers to a private or loopback address.
 * Handles the same hostname formats as isLoopbackHost, but also accepts
 * RFC 1918, link-local, CGNAT, and IPv6 ULA/link-local addresses.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const parsed = typeof host === "string" ? parseHostForAddressChecks(host) : null;
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  const normalized = normalizeIpAddress(parsed.unbracketedHost);
  if (!normalized || !isPrivateOrLoopbackAddress(normalized)) {
    return false;
  }
  // isPrivateOrLoopbackAddress reuses SSRF-blocking ranges for IPv6, which
  // include unspecified (::) and multicast (ff00::/8). Exclude these —
  // they are not private/loopback unicast endpoints. (Multicast is UDP-only
  // so TCP/WebSocket connections would fail regardless.)
  if (net.isIP(normalized) === 6) {
    if (normalized.startsWith("ff")) {
      return false;
    }
    if (normalized === "::") {
      return false;
    }
  }
  return true;
}

/**
 * Security check for WebSocket URLs (CWE-319: Cleartext Transmission of Sensitive Information).
 *
 * Returns true if the URL is secure for transmitting data:
 * - wss:// (TLS) is always secure
 * - ws:// is secure for loopback, private IP literals, .local, and Tailnet hosts
 * - optional break-glass: other private-DNS ws:// hostnames can be enabled for trusted networks
 *
 * All other ws:// URLs are considered insecure because both credentials
 * AND chat/conversation data would be exposed to network interception.
 */
export function isSecureWebSocketUrl(
  url: string,
  opts?: {
    allowPrivateWs?: boolean;
  },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Node's ws client accepts http(s) URLs and normalizes them to ws(s).
  // Treat those aliases the same way here so loopback cron announce delivery
  // and TLS-backed https endpoints follow the same security policy.
  const protocol = normalizeWebSocketProtocol(parsed.protocol);

  if (protocol === "wss:") {
    return true;
  }

  if (protocol !== "ws:") {
    return false;
  }

  // Default policy allows local/Tailnet endpoints that cannot be given public TLS
  // without extra operator setup. Public DNS hostnames still require wss://.
  if (isLoopbackHost(parsed.hostname)) {
    return true;
  }
  if (isTrustedPlaintextWebSocketHost(parsed.hostname)) {
    return true;
  }
  // Optional break-glass for trusted private-DNS overlays.
  if (opts?.allowPrivateWs) {
    // Hostnames may resolve to private networks (for example in VPN/Tailnet DNS),
    // but resolution is not available in this synchronous validator.
    const hostForIpCheck =
      parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    return net.isIP(hostForIpCheck) === 0;
  }
  return false;
}

function isTrustedPlaintextWebSocketHost(hostname: string): boolean {
  if (isPrivateOrLoopbackHost(hostname)) {
    return true;
  }
  const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.+$/, "");
  return normalized.endsWith(".local") || normalized.endsWith(".ts.net");
}
