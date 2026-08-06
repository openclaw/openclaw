import type { IncomingMessage } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import type { AuthRateLimitSubject } from "./auth-rate-limit.js";
import {
  hasForwardedRequestHeaders,
  isLoopbackAddress,
  isTrustedProxyAddress,
  resolveClientIp,
  resolveRequestClientIp,
} from "./net.js";
import {
  readGatewayTailscaleIngressMode,
  type GatewayTailscaleIngressMode,
} from "./tailscale-ingress-state.js";

export const PROXY_ATTRIBUTION_REQUIRED_REASON = "proxy_attribution_required";
export const PROXY_ATTRIBUTION_GUIDANCE =
  "Configure gateway.trustedProxies narrowly and make the proxy overwrite or safely rebuild forwarded client headers.";

export type VerifiedTailscaleIngressIdentity = {
  login: string;
  name: string;
  profilePic?: string;
};

export type GatewayIngressRateLimitPolicy = {
  subject: AuthRateLimitSubject;
  resetOnSuccess: boolean;
};

type AttributedGatewayIngress = {
  clientIp: string;
  localDirect: boolean;
  rateLimit: GatewayIngressRateLimitPolicy;
  tailscaleIdentity?: VerifiedTailscaleIngressIdentity;
};

export type GatewayIngressAttribution =
  | (AttributedGatewayIngress & { kind: "direct-local" })
  | (AttributedGatewayIngress & { kind: "direct-remote" })
  | (AttributedGatewayIngress & { kind: "trusted-proxy" })
  | (AttributedGatewayIngress & { kind: "tailscale-serve" })
  | (AttributedGatewayIngress & { kind: "tailscale-funnel" })
  | {
      kind: "unattributable-proxy";
      localDirect: false;
      reason: typeof PROXY_ATTRIBUTION_REQUIRED_REASON;
      guidance: typeof PROXY_ATTRIBUTION_GUIDANCE;
      remoteAddress: string;
    };

export type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasTailscaleProxyHeaders(req: IncomingMessage): boolean {
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function hasTailscaleModeEvidence(
  req: IncomingMessage,
  mode: GatewayTailscaleIngressMode,
): boolean {
  if (mode === "serve") {
    return Boolean(normalizeOptionalString(req.headers["tailscale-user-login"]));
  }
  return mode === "funnel" && headerValue(req.headers["tailscale-funnel-request"]) === "?1";
}

function buildAttributedIngress(params: {
  kind: Exclude<GatewayIngressAttribution["kind"], "unattributable-proxy">;
  clientIp: string;
  localDirect?: boolean;
  tailscaleIdentity?: VerifiedTailscaleIngressIdentity;
}): AttributedGatewayIngress & {
  kind: Exclude<GatewayIngressAttribution["kind"], "unattributable-proxy">;
} {
  return {
    kind: params.kind,
    clientIp: params.clientIp,
    localDirect: params.localDirect === true,
    rateLimit: {
      subject: {
        key: params.clientIp,
        exemption: params.localDirect === true ? "configured-loopback" : "none",
      },
      resetOnSuccess: true,
    },
    ...(params.tailscaleIdentity ? { tailscaleIdentity: params.tailscaleIdentity } : {}),
  };
}

function unattributableProxy(remoteAddress: string): GatewayIngressAttribution {
  return {
    kind: "unattributable-proxy",
    localDirect: false,
    reason: PROXY_ATTRIBUTION_REQUIRED_REASON,
    guidance: PROXY_ATTRIBUTION_GUIDANCE,
    remoteAddress,
  };
}

function resolveTailscaleForwardedClient(req: IncomingMessage): string | undefined {
  return resolveClientIp({
    remoteAddr: req.socket.remoteAddress,
    forwardedFor: headerValue(req.headers["x-forwarded-for"]),
    trustedProxies: ["127.0.0.1", "::1"],
  });
}

async function resolveTailscaleIngress(params: {
  req: IncomingMessage;
  effectiveMode: GatewayTailscaleIngressMode;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<GatewayIngressAttribution | undefined> {
  const { req, effectiveMode } = params;
  if (effectiveMode === "off" || !hasTailscaleProxyHeaders(req)) {
    return undefined;
  }
  const clientIp = resolveTailscaleForwardedClient(req);
  if (!clientIp) {
    return unattributableProxy(req.socket.remoteAddress ?? "unknown");
  }
  if (effectiveMode === "funnel") {
    if (headerValue(req.headers["tailscale-funnel-request"]) !== "?1") {
      return unattributableProxy(req.socket.remoteAddress ?? "unknown");
    }
    return buildAttributedIngress({ kind: "tailscale-funnel", clientIp });
  }

  const headerLogin = normalizeOptionalString(req.headers["tailscale-user-login"]);
  if (!headerLogin) {
    return unattributableProxy(req.socket.remoteAddress ?? "unknown");
  }
  const whois = await params.tailscaleWhois(clientIp);
  if (!whois?.login) {
    return unattributableProxy(req.socket.remoteAddress ?? "unknown");
  }
  if (headerLogin.toLowerCase() !== whois.login.toLowerCase()) {
    return unattributableProxy(req.socket.remoteAddress ?? "unknown");
  }
  const headerName = normalizeOptionalString(req.headers["tailscale-user-name"]);
  const profilePic = normalizeOptionalString(req.headers["tailscale-user-profile-pic"]);
  return buildAttributedIngress({
    kind: "tailscale-serve",
    clientIp,
    tailscaleIdentity: {
      login: whois.login,
      name: whois.name ?? headerName ?? whois.login,
      ...(profilePic ? { profilePic } : {}),
    },
  });
}

export async function resolveGatewayIngressAttribution(params: {
  req: IncomingMessage;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  tailscaleWhois?: TailscaleWhoisLookup;
  tailscaleMode?: GatewayTailscaleIngressMode;
}): Promise<GatewayIngressAttribution> {
  const { req } = params;
  const remoteAddress =
    resolveClientIp({ remoteAddr: req.socket.remoteAddress }) ??
    req.socket.remoteAddress ??
    "unknown";
  const hasProxyHeaders = hasForwardedRequestHeaders(req);
  const remoteIsLoopback = isLoopbackAddress(remoteAddress);

  if (remoteIsLoopback && !hasProxyHeaders) {
    return buildAttributedIngress({
      kind: "direct-local",
      clientIp: remoteAddress,
      localDirect: true,
    });
  }

  if (remoteIsLoopback && hasProxyHeaders) {
    const managedTailscaleMode =
      params.tailscaleMode ?? readGatewayTailscaleIngressMode(req.socket.localPort);
    if (hasTailscaleModeEvidence(req, managedTailscaleMode)) {
      const tailscale = await resolveTailscaleIngress({
        req,
        effectiveMode: managedTailscaleMode,
        tailscaleWhois: params.tailscaleWhois ?? readTailscaleWhoisIdentity,
      });
      if (tailscale) {
        return tailscale;
      }
    }
  }

  if (isTrustedProxyAddress(remoteAddress, params.trustedProxies)) {
    const clientIp = resolveRequestClientIp(
      req,
      params.trustedProxies,
      params.allowRealIpFallback === true,
    );
    return clientIp
      ? buildAttributedIngress({ kind: "trusted-proxy", clientIp })
      : unattributableProxy(remoteAddress);
  }

  if (remoteIsLoopback && hasProxyHeaders) {
    return unattributableProxy(remoteAddress);
  }

  return buildAttributedIngress({ kind: "direct-remote", clientIp: remoteAddress });
}

const preparedAttribution = new WeakMap<IncomingMessage, Promise<GatewayIngressAttribution>>();

export function prepareGatewayIngressAttribution(
  params: Parameters<typeof resolveGatewayIngressAttribution>[0],
): Promise<GatewayIngressAttribution> {
  const existing = preparedAttribution.get(params.req);
  if (existing) {
    return existing;
  }
  const prepared = resolveGatewayIngressAttribution(params);
  preparedAttribution.set(params.req, prepared);
  return prepared;
}

export function createGatewayIngressAttributionDiagnostics(params: {
  warn: (message: string) => void;
  intervalMs?: number;
  maxKeys?: number;
}) {
  const intervalMs = params.intervalMs ?? 5 * 60_000;
  const maxKeys = params.maxKeys ?? 64;
  const warnedAt = new Map<string, number>();
  return {
    observe(attribution: GatewayIngressAttribution, req: IncomingMessage): void {
      if (attribution.kind !== "unattributable-proxy") {
        return;
      }
      const key = `${attribution.remoteAddress}:${req.socket.localPort ?? "unknown"}`;
      const now = Date.now();
      const previous = warnedAt.get(key);
      if (previous !== undefined && now - previous < intervalMs) {
        return;
      }
      if (!warnedAt.has(key) && warnedAt.size >= maxKeys) {
        const oldest = warnedAt.keys().next().value;
        if (oldest !== undefined) {
          warnedAt.delete(oldest);
        }
      }
      warnedAt.delete(key);
      warnedAt.set(key, now);
      params.warn(
        `gateway rejected unattributable proxy traffic from ${attribution.remoteAddress}. ${PROXY_ATTRIBUTION_GUIDANCE}`,
      );
    },
  };
}

export type GatewayIngressAttributionDiagnostics = ReturnType<
  typeof createGatewayIngressAttributionDiagnostics
>;
