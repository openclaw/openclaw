import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { buildRateLimitIdentityKey, createAuthRateLimiter } from "./auth-rate-limit.js";
import {
  createGatewayIngressAttributionDiagnostics,
  type GatewayIngressAttribution,
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
const managedProxyKey = buildRateLimitIdentityKey("managed-tailscale-proxy", "127.0.0.1");

function serveIdentity(attribution: GatewayIngressAttribution) {
  if (attribution.kind !== "tailscale-serve") {
    throw new Error(`expected Serve attribution, got ${attribution.kind}`);
  }
  return attribution.verifyIdentity();
}

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

  it("does not use external Serve identity when permission is disabled", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({
        headers: { ...proxyHeaders, "tailscale-user-login": "owner@example.test" },
      }),
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

    expect(attribution).toMatchObject({
      kind: "tailscale-serve",
      provenance: "managed-route",
      clientIp: "100.64.0.9",
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
    await expect(serveIdentity(attribution)).resolves.toMatchObject({
      login: "owner@example.test",
    });
    expect(tailscaleWhois).toHaveBeenCalledOnce();
  });

  it("uses one non-resetting shared-secret subject until managed Serve identity verifies", async () => {
    const resolveClient = async (clientIp: string) =>
      await resolveGatewayIngressAttribution({
        req: request({
          headers: {
            ...proxyHeaders,
            "x-forwarded-for": clientIp,
            "tailscale-user-login": `${clientIp}@example.test`,
          },
        }),
        tailscaleMode: "serve",
      });

    const clientA = await resolveClient("100.64.0.9");
    const clientB = await resolveClient("100.64.0.10");

    expect(clientA).toMatchObject({
      kind: "tailscale-serve",
      clientIp: "100.64.0.9",
      rateLimit: {
        subject: { key: managedProxyKey, exemption: "none" },
        resetOnSuccess: false,
      },
    });
    expect(clientB).toMatchObject({
      kind: "tailscale-serve",
      clientIp: "100.64.0.10",
      rateLimit: {
        subject: { key: managedProxyKey, exemption: "none" },
        resetOnSuccess: false,
      },
    });
  });

  it("isolates managed proxy failures from direct-local success resets", async () => {
    const managed = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      tailscaleMode: "serve",
    });
    const direct = await resolveGatewayIngressAttribution({ req: request({}) });
    if (managed.kind === "unattributable-proxy" || direct.kind === "unattributable-proxy") {
      throw new Error("expected attributed ingress");
    }

    const limiter = createAuthRateLimiter({ maxAttempts: 1, pruneIntervalMs: 0 });
    limiter.recordFailure(managed.rateLimit.subject);
    expect(limiter.check(managed.rateLimit.subject).allowed).toBe(false);
    limiter.reset(direct.rateLimit.subject);
    expect(limiter.check(managed.rateLimit.subject).allowed).toBe(false);
    limiter.dispose();
  });

  it("keeps tagged managed Serve clients eligible for shared-secret auth", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({ headers: { ...proxyHeaders, "x-forwarded-for": "100.64.0.9" } }),
      tailscaleMode: "serve",
      tailscaleWhois,
    });

    expect(attribution).toMatchObject({
      kind: "tailscale-serve",
      provenance: "managed-route",
      rateLimit: {
        subject: { key: managedProxyKey, exemption: "none" },
        resetOnSuccess: false,
      },
    });
    await expect(serveIdentity(attribution)).resolves.toBeUndefined();
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("uses managed Serve attribution without identity evidence", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      trustedProxies: ["127.0.0.1"],
      tailscaleMode: "serve",
      tailscaleWhois,
    });

    expect(attribution).toMatchObject({
      kind: "tailscale-serve",
      clientIp: "198.51.100.10",
      provenance: "managed-route",
      rateLimit: {
        subject: { key: managedProxyKey, exemption: "none" },
        resetOnSuccess: false,
      },
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("preserves managed Serve attribution when identity verification fails", async () => {
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
      tailscaleWhois: async () => null,
    });

    expect(attribution.kind).toBe("tailscale-serve");
    await expect(serveIdentity(attribution)).resolves.toBeUndefined();
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

  it("captures and memoizes Serve identity verification after assigning a client subject", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const req = request({
      headers: {
        ...proxyHeaders,
        "x-forwarded-for": "100.64.0.9",
        "tailscale-user-login": "owner@example.test",
      },
    });
    const attribution = await resolveGatewayIngressAttribution({
      req,
      tailscaleMode: "serve",
      tailscaleWhois,
    });

    expect(attribution).toMatchObject({
      kind: "tailscale-serve",
      clientIp: "100.64.0.9",
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
    req.headers["x-forwarded-for"] = "100.64.0.99";
    req.headers["tailscale-user-login"] = "mutated@example.test";
    const first = serveIdentity(attribution);
    const second = serveIdentity(attribution);
    await expect(first).resolves.toMatchObject({
      login: "owner@example.test",
    });
    await expect(second).resolves.toMatchObject({ login: "owner@example.test" });
    expect(tailscaleWhois).toHaveBeenCalledWith("100.64.0.9");
    expect(tailscaleWhois).toHaveBeenCalledOnce();
  });

  it("preserves separately managed Serve when explicitly enabled and verified", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({
        headers: {
          ...proxyHeaders,
          "x-forwarded-for": "100.64.0.10",
          "tailscale-user-login": "owner@example.test",
        },
      }),
      trustedProxies: ["127.0.0.1"],
      allowVerifiedExternalServe: true,
      tailscaleWhois,
    });

    expect(attribution).toMatchObject({
      kind: "tailscale-serve",
      provenance: "operator-trusted-proxy",
      clientIp: "100.64.0.10",
      rateLimit: { subject: { key: "100.64.0.10", exemption: "none" } },
    });
    expect(tailscaleWhois).not.toHaveBeenCalled();
    await expect(serveIdentity(attribution)).resolves.toMatchObject({
      login: "owner@example.test",
    });
    expect(tailscaleWhois).toHaveBeenCalledWith("100.64.0.10");
  });

  it("does not infer separately managed Serve without trusted proxy provenance", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({
        headers: {
          ...proxyHeaders,
          "x-forwarded-for": "100.64.0.10",
          "tailscale-user-login": "owner@example.test",
        },
      }),
      allowVerifiedExternalServe: true,
      tailscaleWhois,
    });

    expect(tailscaleWhois).not.toHaveBeenCalled();
    expect(attribution.kind).toBe("unattributable-proxy");
  });

  it("does not run external Serve WhoIs without an identity header", async () => {
    const tailscaleWhois = vi.fn(async () => ({ login: "owner@example.test", name: "Owner" }));
    const attribution = await resolveGatewayIngressAttribution({
      req: request({ headers: proxyHeaders }),
      trustedProxies: ["127.0.0.1"],
      allowVerifiedExternalServe: true,
      tailscaleWhois,
    });

    expect(tailscaleWhois).not.toHaveBeenCalled();
    expect(attribution.kind).toBe("trusted-proxy");
  });

  it.each([
    ["mismatched identity", async () => ({ login: "other@example.test", name: "Other" })],
    ["missing identity", async () => null],
    [
      "WhoIs failure",
      async () => {
        throw new Error("WhoIs unavailable");
      },
    ],
  ])("withholds external Serve identity for %s", async (_name, tailscaleWhois) => {
    const attribution = await resolveGatewayIngressAttribution({
      req: request({
        headers: {
          ...proxyHeaders,
          "x-forwarded-for": "100.64.0.10",
          "tailscale-user-login": "owner@example.test",
        },
      }),
      trustedProxies: ["127.0.0.1"],
      allowVerifiedExternalServe: true,
      tailscaleWhois,
    });

    expect(attribution.kind).toBe("tailscale-serve");
    await expect(serveIdentity(attribution)).resolves.toBeUndefined();
  });

  it("bounds and deduplicates external Serve WhoIs", async () => {
    const resolvers: Array<() => void> = [];
    const tailscaleWhois = vi.fn(
      async (ip: string) =>
        await new Promise<{ login: string; name: string } | null>((resolve) => {
          resolvers.push(() => resolve({ login: `${ip}@example.test`, name: ip }));
        }),
    );
    const lookup = (client: number) =>
      resolveGatewayIngressAttribution({
        req: request({
          headers: {
            ...proxyHeaders,
            "x-forwarded-for": `100.64.0.${client}`,
            "tailscale-user-login": `100.64.0.${client}@example.test`,
          },
        }),
        trustedProxies: ["127.0.0.1"],
        allowVerifiedExternalServe: true,
        tailscaleWhois,
      });

    const firstAttribution = await lookup(20);
    const duplicateAttribution = await lookup(20);
    const admittedAttributions = await Promise.all(
      Array.from({ length: 7 }, (_, index) => lookup(21 + index)),
    );
    const rejectedAttribution = await lookup(28);

    const first = serveIdentity(firstAttribution);
    const duplicate = serveIdentity(duplicateAttribution);
    const admitted = admittedAttributions.map((attribution) => serveIdentity(attribution));
    const rejected = serveIdentity(rejectedAttribution);

    expect(tailscaleWhois).toHaveBeenCalledTimes(8);
    await expect(rejected).resolves.toBeUndefined();
    for (const resolve of resolvers) {
      resolve();
    }
    await expect(Promise.all([first, duplicate, ...admitted])).resolves.toHaveLength(9);
  });

  it("requires active Funnel provenance and the sanitized marker", async () => {
    const attributed = await resolveGatewayIngressAttribution({
      req: request({
        headers: { ...proxyHeaders, "tailscale-funnel-request": "?1" },
      }),
      tailscaleMode: "funnel",
    });
    const otherClient = await resolveGatewayIngressAttribution({
      req: request({
        headers: {
          ...proxyHeaders,
          "x-forwarded-for": "198.51.100.11",
          "tailscale-funnel-request": "?1",
        },
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

    expect(attributed).toMatchObject({
      kind: "tailscale-funnel",
      clientIp: "198.51.100.10",
      rateLimit: {
        subject: { key: managedProxyKey, exemption: "none" },
        resetOnSuccess: false,
      },
    });
    expect(otherClient).toMatchObject({
      kind: "tailscale-funnel",
      clientIp: "198.51.100.11",
      rateLimit: {
        subject: { key: managedProxyKey, exemption: "none" },
        resetOnSuccess: false,
      },
    });
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
