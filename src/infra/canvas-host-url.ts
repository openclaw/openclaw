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
  try {
    return new URL(`http://${String(value).trim()}`).hostname;
  } catch {
    return "";
  }
};

const parseForwardedProto = (value: HostSource | HostSource[]) => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

export function resolveCanvasHostUrl(params: CanvasHostUrlParams) {
  const port = params.canvasPort;
  if (!port) {
    return undefined;
  }

  const scheme =
    params.scheme ??
    (parseForwardedProto(params.forwardedProto)?.trim() === "https" ? "https" : "http");

  const override = normalizeHost(params.hostOverride, true);
  const requestHost = normalizeHost(parseHostHeader(params.requestHost), !!override);
  const localAddress = normalizeHost(params.localAddress, Boolean(override || requestHost));

  const host = override || requestHost || localAddress;
  if (!host) {
    return undefined;
  }
  const formatted = host.includes(":") ? `[${host}]` : host;

  // When behind a TLS-terminating reverse proxy (e.g. Tailscale Serve),
  // the forwarded proto is "https" but the backend port is plain HTTP.
  // Use the default HTTPS port (443) instead of the backend port so the
  // client connects to the proxy, not directly to the backend.
  const resolvedPort =
    scheme === "https" && parseForwardedProto(params.forwardedProto)?.trim() === "https"
      ? 443
      : port;

  // Omit port when it matches the scheme default (443 for https, 80 for http).
  const omitPort =
    (scheme === "https" && resolvedPort === 443) || (scheme === "http" && resolvedPort === 80);
  return omitPort ? `${scheme}://${formatted}` : `${scheme}://${formatted}:${resolvedPort}`;
}
