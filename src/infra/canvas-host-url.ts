import { isLoopbackHost } from "../gateway/net.js";

type HostSource = string | null | undefined;

type CanvasHostUrlParams = {
  canvasPort?: number;
  hostOverride?: HostSource;
  requestHost?: HostSource;
  forwardedProto?: HostSource | HostSource[];
  localAddress?: HostSource;
  scheme?: "http" | "https";
};

const normalizeHost = (value: HostSource, rejectLoopback: boolean) => {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (rejectLoopback && isLoopbackHost(trimmed)) {
    return "";
  }
  return trimmed;
};

const parseHostHeader = (value: HostSource) => {
  if (!value) {
    return "";
  }
  const raw = String(value).trim();
  try {
    const hostname = new URL(`http://${raw}`).hostname;
    // Strip brackets from IPv6 addresses (URL API may include them)
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return hostname.slice(1, -1);
    }
    return hostname;
  } catch {
    // URL API may reject out-of-range ports; try manual extraction
    // Handle IPv6 with port: [::1]:8080 -> ::1
    const ipv6Match = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (ipv6Match) {
      return ipv6Match[1];
    }
    // Handle host:port where port may be invalid
    const lastColon = raw.lastIndexOf(":");
    if (lastColon > 0 && /^\d+$/.test(raw.slice(lastColon + 1))) {
      return raw.slice(0, lastColon);
    }
    return "";
  }
};

// Extract port from Host header (e.g., "node.tailnet:443" -> 443)
// This is needed for reverse proxy setups like Tailscale Serve
const parseHostPort = (value: HostSource): number | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const raw = String(value).trim();
    const url = new URL(`http://${raw}`);
    let port: number | undefined;
    // url.port is empty string for default ports (80 for http, 443 for https)
    if (url.port) {
      port = parseInt(url.port, 10);
    } else {
      // Check if the original string had an explicit port (handles :80 and :443)
      const portMatch = raw.match(/:(\d+)$/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }
    }
    // Validate port is a valid integer in range 1-65535
    if (port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const parseForwardedProto = (value: HostSource | HostSource[]) => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

export function resolveCanvasHostUrl(params: CanvasHostUrlParams) {
  const scheme =
    params.scheme ??
    (parseForwardedProto(params.forwardedProto)?.trim() === "https" ? "https" : "http");

  // Port priority: hostOverride port → Host header port → canvasPort
  // This ensures hostOverride with explicit port is fully respected
  const overridePort = parseHostPort(params.hostOverride);
  const hostHeaderPort = parseHostPort(params.requestHost);
  const port = overridePort ?? hostHeaderPort ?? params.canvasPort;

  if (!port) {
    return undefined;
  }

  // Extract hostname from hostOverride (strip port if present)
  const override = normalizeHost(parseHostHeader(params.hostOverride), true);
  const requestHost = normalizeHost(parseHostHeader(params.requestHost), !!override);
  const localAddress = normalizeHost(params.localAddress, Boolean(override || requestHost));

  const host = override || requestHost || localAddress;
  if (!host) {
    return undefined;
  }
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${formatted}:${port}`;
}
