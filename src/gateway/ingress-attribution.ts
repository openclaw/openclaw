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
};

export type GatewayIngressAttribution =
  | (AttributedGatewayIngress & { kind: "direct-local" })
  | (AttributedGatewayIngress & { kind: "direct-remote" })
  | (AttributedGatewayIngress & { kind: "trusted-proxy" })
  | (AttributedGatewayIngress & {
      kind: "tailscale-serve";
      provenance: "managed-route" | "operator-trusted-proxy";
      verifyIdentity: () => Promise<VerifiedTailscaleIngressIdentity | undefined>;
    })
  | (AttributedGatewayIngress & { kind: "tailscale-funnel" })
  | {
      kind: "unattributable-proxy";
      localDirect: false;
      reason: typeof PROXY_ATTRIBUTION_REQUIRED_REASON;
      guidance: typeof PROXY_ATTRIBUTION_GUIDANCE;
      remoteAddress: string;
    };

export type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

const EXTERNAL_SERVE_WHOIS_MAX_CONCURRENT = 8;
const EXTERNAL_SERVE_WHOIS_MAX_KEYS_PER_WINDOW = 64;
const EXTERNAL_SERVE_WHOIS_WINDOW_MS = 60_000;

type ExternalServeWhoisAdmissionState = {
  inFlight: Map<string, Promise<TailscaleWhoisIdentity | null>>;
  admittedAt: Map<string, number>;
};

const externalServeWhoisAdmission = new WeakMap<
  TailscaleWhoisLookup,
  ExternalServeWhoisAdmissionState
>();

// External proxy headers arrive before credentials, so bound distinct WhoIs work
// and share in-flight lookups instead of allowing pre-auth subprocess amplification.
function runExternalServeWhois(
  lookup: TailscaleWhoisLookup,
  clientIp: string,
): Promise<TailscaleWhoisIdentity | null> {
  let state = externalServeWhoisAdmission.get(lookup);
  if (!state) {
    state = { inFlight: new Map(), admittedAt: new Map() };
    externalServeWhoisAdmission.set(lookup, state);
  }
  const existing = state.inFlight.get(clientIp);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  for (const [key, admittedAt] of state.admittedAt) {
    if (now - admittedAt >= EXTERNAL_SERVE_WHOIS_WINDOW_MS) {
      state.admittedAt.delete(key);
    }
  }
  if (
    state.inFlight.size >= EXTERNAL_SERVE_WHOIS_MAX_CONCURRENT ||
    (!state.admittedAt.has(clientIp) &&
      state.admittedAt.size >= EXTERNAL_SERVE_WHOIS_MAX_KEYS_PER_WINDOW)
  ) {
    return Promise.resolve(null);
  }

  state.admittedAt.delete(clientIp);
  state.admittedAt.set(clientIp, now);
  const pending = lookup(clientIp).finally(() => {
    state?.inFlight.delete(clientIp);
  });
  state.inFlight.set(clientIp, pending);
  return pending;
}

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
    // The registered managed route is the provenance. Tagged Serve clients
    // omit user identity headers but must still reach shared-secret auth.
    return true;
  }
  return mode === "funnel" && headerValue(req.headers["tailscale-funnel-request"]) === "?1";
}

function buildAttributedIngress<
  Kind extends Exclude<GatewayIngressAttribution["kind"], "unattributable-proxy">,
>(params: {
  kind: Kind;
  clientIp: string;
  localDirect?: boolean;
}): AttributedGatewayIngress & {
  kind: Kind;
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
  externalServe?: boolean;
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
    return {
      ...buildAttributedIngress({ kind: "tailscale-funnel", clientIp }),
      // The marker identifies managed Funnel mode but is not connection-bound.
      // Keep unverified shared-secret attempts on one non-resetting peer bucket.
      rateLimit: {
        subject: { key: req.socket.remoteAddress ?? "unknown", exemption: "none" },
        resetOnSuccess: false,
      },
    };
  }

  const headerLogin = normalizeOptionalString(req.headers["tailscale-user-login"]);
  const headerName = normalizeOptionalString(req.headers["tailscale-user-name"]);
  const profilePic = normalizeOptionalString(req.headers["tailscale-user-profile-pic"]);
  let identityPromise: Promise<VerifiedTailscaleIngressIdentity | undefined> | undefined;
  const verifyIdentity = () => {
    if (!headerLogin) {
      return Promise.resolve(undefined);
    }
    identityPromise ??= (async () => {
      try {
        const whois = await (params.externalServe
          ? runExternalServeWhois(params.tailscaleWhois, clientIp)
          : params.tailscaleWhois(clientIp));
        if (
          !headerLogin ||
          !whois?.login ||
          headerLogin.toLowerCase() !== whois.login.toLowerCase()
        ) {
          return undefined;
        }
        return {
          login: whois.login,
          name: whois.name ?? headerName ?? whois.login,
          ...(profilePic ? { profilePic } : {}),
        };
      } catch {
        return undefined;
      }
    })();
    return identityPromise;
  };
  const attributed = buildAttributedIngress({
    kind: "tailscale-serve",
    clientIp,
  });
  return {
    ...attributed,
    ...(params.externalServe
      ? {}
      : {
          // Until WhoIs verifies ambient identity, claimed forwarded IPs cannot
          // select shared-secret buckets or reset failures from another caller.
          rateLimit: {
            subject: {
              key: req.socket.remoteAddress ?? "unknown",
              exemption: "none" as const,
            },
            resetOnSuccess: false,
          },
        }),
    provenance: params.externalServe ? "operator-trusted-proxy" : "managed-route",
    // Capture immutable request facts now; WhoIs runs only if tokenless identity auth is selected.
    verifyIdentity,
  };
}

export async function resolveGatewayIngressAttribution(params: {
  req: IncomingMessage;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  allowVerifiedExternalServe?: boolean;
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
    if (!clientIp) {
      return unattributableProxy(remoteAddress);
    }
    const managedTailscaleMode =
      params.tailscaleMode ?? readGatewayTailscaleIngressMode(req.socket.localPort);
    if (
      remoteIsLoopback &&
      managedTailscaleMode === "off" &&
      params.allowVerifiedExternalServe &&
      Boolean(normalizeOptionalString(req.headers["tailscale-user-login"]))
    ) {
      const tailscale = await resolveTailscaleIngress({
        req,
        effectiveMode: "serve",
        tailscaleWhois: params.tailscaleWhois ?? readTailscaleWhoisIdentity,
        externalServe: true,
      });
      if (tailscale?.kind === "tailscale-serve") {
        return tailscale;
      }
    }
    return buildAttributedIngress({ kind: "trusted-proxy", clientIp });
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
