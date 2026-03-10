// ui/src/ui/control-ui-url.ts
// Resolves Control UI HTTP endpoints against the active gateway target.
// Keeps same-origin mounts relative, but switches to absolute HTTP(S) URLs for remote gateways.
import { normalizeBasePath } from "./navigation.ts";

const GATEWAY_HTTP_PROTOCOLS: Record<string, string> = {
  "ws:": "http:",
  "wss:": "https:",
  "http:": "http:",
  "https:": "https:",
};

export function resolveControlUiHttpBase(params: {
  gatewayUrl?: string | null;
  basePath?: string | null;
  pageUrl?: string;
}): string {
  const fallbackBasePath = normalizeBasePath(params.basePath ?? "");
  const gatewayUrl = params.gatewayUrl?.trim();
  if (!gatewayUrl) {
    return fallbackBasePath;
  }

  try {
    const pageUrl =
      params.pageUrl ?? (typeof window === "undefined" ? undefined : window.location.href);
    const gateway = pageUrl ? new URL(gatewayUrl, pageUrl) : new URL(gatewayUrl);
    const httpProtocol = GATEWAY_HTTP_PROTOCOLS[gateway.protocol];
    if (!httpProtocol) {
      return fallbackBasePath;
    }
    const gatewayBasePath =
      gateway.pathname === "/" ? "" : normalizeBasePath(gateway.pathname || "");
    if (pageUrl) {
      const page = new URL(pageUrl);
      if (gateway.host === page.host) {
        return gatewayBasePath || fallbackBasePath;
      }
    }
    return `${httpProtocol}//${gateway.host}${gatewayBasePath || fallbackBasePath}`;
  } catch {
    return fallbackBasePath;
  }
}

export function buildControlUiHttpUrl(params: {
  gatewayUrl?: string | null;
  basePath?: string | null;
  pageUrl?: string;
  path: string;
}): string {
  const base = resolveControlUiHttpBase(params);
  return base ? `${base}${params.path}` : params.path;
}
