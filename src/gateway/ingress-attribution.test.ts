import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import {
  createGatewayIngressAttributionDiagnostics,
  PROXY_ATTRIBUTION_REQUIRED_REASON,
  resolveGatewayIngressAttribution,
} from "./ingress-attribution.js";

function request(params: {
  remoteAddress?: string;
  localPort?: number;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    socket: {
      remoteAddress: params.remoteAddress ?? "127.0.0.1",
      localPort: params.localPort ?? 18789,
    },
    headers: params.headers ?? {},
  } as unknown as IncomingMessage;
}

const proxyHeaders = {
  "x-forwarded-for": "198.51.100.10",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "gateway.example.test",
};

describe("gateway ingress attribution", () => {
  it("documents that a headerless TCP forwarder is indistinguishable from clean loopback", async () => {
    const clean = await resolveGatewayIngressAttribution({ req: request({}) });
    const headerlessForwarder = await resolveGatewayIngressAttribution({ req: request({}) });

    expect(clean).toMatchObject({ kind: "direct-local", localDirect: true });
    expect(headerlessForwarder).toEqual(clean);
  });

  it("fails closed for header-bearing untrusted loopback traffic", async () => {
    const attribution = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
    });

    expect(attribution).toMatchObject({
      kind: "unattributable-proxy",
      reason: PROXY_ATTRIBUTION_REQUIRED_REASON,
    });
    expect("rateLimit" in attribution).toBe(false);
  });

  it("uses isolated non-exempt subjects for configured proxy clients", async () => {
    const clientA = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      trustedProxies: ["127.0.0.1"],
    });
    const clientB = await resolveGatewayIngressAttribution({
      req: request({
        headers: { ...proxyHeaders, "x-forwarded-for": "198.51.100.11" },
      }),
      trustedProxies: ["127.0.0.1"],
    });
    expect(clientA).toMatchObject({
      kind: "trusted-proxy",
      clientIp: "198.51.100.10",
      rateLimit: { subject: { exemption: "none" }, resetOnSuccess: true },
    });
    expect(clientB).toMatchObject({ clientIp: "198.51.100.11" });

    if (clientA.kind === "unattributable-proxy" || clientB.kind === "unattributable-proxy") {
      throw new Error("expected attributed proxy clients");
    }
    const limiter = createAuthRateLimiter({ maxAttempts: 1, pruneIntervalMs: 0 });
    limiter.recordFailure(clientA.rateLimit.subject);
    expect(limiter.check(clientA.rateLimit.subject).allowed).toBe(false);
    expect(limiter.check(clientB.rateLimit.subject).allowed).toBe(true);
    limiter.reset(clientB.rateLimit.subject);
    expect(limiter.check(clientA.rateLimit.subject).allowed).toBe(false);
    limiter.dispose();
  });

  it("uses an explicitly trusted proxy when no managed Tailscale route is active", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      trustedProxies: ["127.0.0.1"],
      tailscaleWhois,
    });

    expect(attribution).toMatchObject({
      kind: "trusted-proxy",
      clientIp: "198.51.100.10",
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("honors managed Serve provenance before generic trusted-proxy policy", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({
        headers: {
          ...proxyHeaders,
          "x-forwarded-for": "100.64.0.9",
          "tailscale-user-login": "owner@example.test",
        },
      }),
      trustedProxies: ["127.0.0.1"],
      tailscaleMode: "serve",
      tailscaleWhois,
    });

    expect(attribution).toMatchObject({ kind: "tailscale-serve", clientIp: "100.64.0.9" });
    expect(tailscaleWhois).toHaveBeenCalledOnce();
  });

  it("preserves generic trusted-proxy attribution without Serve identity evidence", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      trustedProxies: ["127.0.0.1"],
      tailscaleMode: "serve",
      tailscaleWhois,
    });

    expect(attribution).toMatchObject({
      kind: "trusted-proxy",
      clientIp: "198.51.100.10",
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("preserves generic trusted-proxy attribution without a Funnel marker", async () => {
    const attribution = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      trustedProxies: ["127.0.0.1"],
      tailscaleMode: "funnel",
    });

    expect(attribution).toMatchObject({
      kind: "trusted-proxy",
      clientIp: "198.51.100.10",
    });
  });

  it("verifies Serve identity before assigning a client subject", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({
        headers: {
          ...proxyHeaders,
          "x-forwarded-for": "100.64.0.9",
          "tailscale-user-login": "owner@example.test",
        },
      }),
      tailscaleMode: "serve",
      tailscaleWhois,
    });

    expect(tailscaleWhois).toHaveBeenCalledWith("100.64.0.9");
    expect(attribution).toMatchObject({
      kind: "tailscale-serve",
      clientIp: "100.64.0.9",
      tailscaleIdentity: { login: "owner@example.test" },
    });
  });

  it("requires registered Serve provenance before running WhoIs", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({
        headers: {
          ...proxyHeaders,
          "x-forwarded-for": "100.64.0.10",
          "tailscale-user-login": "owner@example.test",
        },
      }),
      tailscaleWhois,
    });

    expect(tailscaleWhois).not.toHaveBeenCalled();
    expect(attribution.kind).toBe("unattributable-proxy");
  });

  it("requires active Funnel provenance and the sanitized marker", async () => {
    const attributed = await resolveGatewayIngressAttribution({
      req: request({
        headers: { ...proxyHeaders, "tailscale-funnel-request": "?1" },
      }),
      tailscaleMode: "funnel",
    });
    const missingMarker = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      tailscaleMode: "funnel",
    });
    const inactive = await resolveGatewayIngressAttribution({
      req: request({
        headers: { ...proxyHeaders, "tailscale-funnel-request": "?1" },
      }),
      tailscaleMode: "off",
    });

    expect(attributed).toMatchObject({ kind: "tailscale-funnel", clientIp: "198.51.100.10" });
    expect(missingMarker.kind).toBe("unattributable-proxy");
    expect(inactive.kind).toBe("unattributable-proxy");
  });

  it("bounds duplicate diagnostics across HTTP and WebSocket observations", async () => {
    const warn = vi.fn();
    const diagnostics = createGatewayIngressAttributionDiagnostics({ warn });
    const req = request({ headers: proxyHeaders });
    const attribution = await resolveGatewayIngressAttribution({ req });

    diagnostics.observe(attribution, req);
    diagnostics.observe(attribution, req);
    expect(warn).toHaveBeenCalledOnce();

    diagnostics.observe(await resolveGatewayIngressAttribution({ req: request({}) }), request({}));
    diagnostics.observe(
      await resolveGatewayIngressAttribution({
        req: request({ headers: proxyHeaders }),
        trustedProxies: ["127.0.0.1"],
      }),
      request({ headers: proxyHeaders }),
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});
