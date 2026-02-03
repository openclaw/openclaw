type HostSource = string | null | undefined;

type CanvasHostUrlParams = {
  canvasPort?: number;
  hostOverride?: HostSource;
  requestHost?: HostSource;
  forwardedProto?: HostSource | HostSource[];
  localAddress?: HostSource;
  scheme?: "http" | "https";
};

const isLoopbackHost = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost") {
    return true;
  }
  if (normalized === "::1") {
    return true;
  }
  if (normalized === "0.0.0.0" || normalized === "::") {
    return true;
  }
  return normalized.startsWith("127.");
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
  try {
    const hostname = new URL(`http://${String(value).trim()}`).hostname;
    // Strip brackets from IPv6 addresses (URL API may include them)
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return hostname.slice(1, -1);
    }
    return hostname;
  } catch {
    return "";
  }
};

// Extract port from Host header (e.g., "node.tailnet:443" -> 443)
// This is needed for reverse proxy setups like Tailscale Serve
const parseHostPort = (value: HostSource): number | undefined => {
  if (!value) return undefined;
  try {
    const raw = String(value).trim();
    const url = new URL(`http://${raw}`);
    // url.port is empty string for default ports (80 for http, 443 for https)
    if (url.port) return parseInt(url.port, 10);
    // Check if the original string had an explicit port (handles :80 and :443)
    const portMatch = raw.match(/:(\d+)$/);
    if (portMatch) return parseInt(portMatch[1], 10);
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

  // Prefer port from Host header (respects reverse proxy config like Tailscale Serve)
  const hostHeaderPort = parseHostPort(params.requestHost);
  const port = hostHeaderPort ?? params.canvasPort;

  if (!port) {
    return undefined;
  }

  const override = normalizeHost(params.hostOverride, true);
  const requestHost = normalizeHost(parseHostHeader(params.requestHost), !!override);
  const localAddress = normalizeHost(params.localAddress, Boolean(override || requestHost));

  const host = override || requestHost || localAddress;
  if (!host) {
    return undefined;
  }
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${formatted}:${port}`;
}
