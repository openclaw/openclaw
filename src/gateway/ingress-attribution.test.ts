import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROXY_ATTRIBUTION_GUIDANCE,
  createGatewayUnattributableProxyReporter,
  markGatewayIngressTransport,
  prepareGatewayIngressAttribution,
  type GatewayIngressAttribution,
} from "./ingress-attribution.js";

function request(params?: {
  remoteAddress?: string;
  forwardedFor?: string;
  funnel?: boolean;
  login?: string;
}): IncomingMessage {
  return {
    socket: { remoteAddress: params?.remoteAddress ?? "127.0.0.1" },
    headers: {
      ...(params?.forwardedFor
        ? {
            "x-forwarded-for": params.forwardedFor,
            "x-forwarded-proto": "https",
            "x-forwarded-host": "gateway.tailnet.ts.net",
          }
        : {}),
      ...(params?.funnel ? { "tailscale-funnel-request": "?1" } : {}),
      ...(params?.login ? { "tailscale-user-login": params.login } : {}),
    },
  } as IncomingMessage;
}

afterEach(() => vi.useRealTimers());

const unattributableSource = (
  index: number,
): Extract<GatewayIngressAttribution, { kind: "unattributable-proxy" }> => ({
  kind: "unattributable-proxy" as const,
  reason: "proxy_attribution_required" as const,
  guidance: PROXY_ATTRIBUTION_GUIDANCE,
  remoteAddress: `192.0.2.${index}`,
});

function warningFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const warn = vi.fn();
  const report = createGatewayUnattributableProxyReporter({ warn });
  return { warn, report, attribution: unattributableSource(10) };
}

const source = (kind: string, clientIp: string) => ({
  kind,
  clientIp,
  rateLimit: { subject: { key: clientIp }, resetOnSuccess: true },
});
const rejected = { kind: "unattributable-proxy", reason: "proxy_attribution_required" };
const forwardedFor = "203.0.113.10";
const login = "alice@example.com";
const loopbackProxy = ["127.0.0.1"];
const externalProxy = source("trusted-proxy", forwardedFor);

describe("gateway ingress attribution", () => {
  it.each<[string, Parameters<typeof request>[0], string[] | undefined, object]>([
    ["clean headerless loopback stays local", {}, undefined, source("direct-local", "127.0.0.1")],
    ["external Serve", { forwardedFor, login }, loopbackProxy, externalProxy],
    [
      "external Funnel",
      { forwardedFor, funnel: true },
      loopbackProxy,
      { ...externalProxy, externalTailscaleExposure: "funnel" },
    ],
    ...["::ffff:10.0.0.0/104", "10.0.0.0/8"].map(
      (cidr): [string, Parameters<typeof request>[0], string[], object] => [
        `trusts proxy in ${cidr}`,
        { remoteAddress: "10.1.2.3", forwardedFor: "203.0.113.9" },
        [cidr],
        source("trusted-proxy", "203.0.113.9"),
      ],
    ),
    [
      "rejects proxy outside mapped CIDR",
      { remoteAddress: "11.1.2.3", forwardedFor: "203.0.113.9" },
      ["::ffff:10.0.0.0/104"],
      rejected,
    ],
    ["rejects missing forwarded client", { login }, loopbackProxy, rejected],
    [
      "rejects loopback forwarded client",
      { login, forwardedFor: "127.0.0.1" },
      loopbackProxy,
      rejected,
    ],
  ])("%s", (_name, input, trustedProxies, expected) => {
    expect(prepareGatewayIngressAttribution({ req: request(input), trustedProxies })).toMatchObject(
      expected,
    );
  });

  it("attributes managed Serve by listener provenance and verifies its identity lazily", async () => {
    const req = request({ forwardedFor: "100.64.0.10", login });
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
    const tailscaleWhois = vi.fn(async () => ({ login, name: "Alice" }));

    const attribution = prepareGatewayIngressAttribution({ req, tailscaleWhois });

    expect(attribution).toMatchObject(source("tailscale-serve", "100.64.0.10"));
    expect(tailscaleWhois).not.toHaveBeenCalled();
    if (attribution.kind !== "tailscale-serve") {
      throw new Error("expected Serve attribution");
    }
    await expect(attribution.verifyIdentity()).resolves.toMatchObject({ login });
    expect(tailscaleWhois).toHaveBeenCalledWith("100.64.0.10");
  });

  it.each<[string, Parameters<typeof request>[0], object, string?]>([
    [
      "first source bucket",
      { forwardedFor, funnel: true },
      source("tailscale-funnel", forwardedFor),
    ],
    [
      "distinct source bucket",
      { forwardedFor: "203.0.113.11", funnel: true },
      source("tailscale-funnel", "203.0.113.11"),
    ],
    [
      "unmarked tailnet source",
      { forwardedFor: "100.64.0.10", login },
      source("tailscale-funnel", "100.64.0.10"),
    ],
    ["invalid marker", { forwardedFor }, rejected, "?0"],
  ])("managed Funnel: %s", (_name, input, expected, marker) => {
    const req = request(input);
    if (marker) {
      req.headers["tailscale-funnel-request"] = marker;
    }
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "funnel" });
    expect(prepareGatewayIngressAttribution({ req })).toMatchObject(expected);
  });

  it("does not let continued traffic keep a source suppressed forever", () => {
    const { warn, report, attribution } = warningFixture();

    // A peer that never stops sending must not refresh its own suppression record.
    for (let minute = 0; minute <= 6; minute += 1) {
      vi.setSystemTime(minute * 60_000);
      report(attribution);
    }

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("retains a full late-window source set across the next budget", () => {
    const { warn, report } = warningFixture();

    vi.setSystemTime(5 * 60_000 - 1_000);
    for (let index = 0; index < 16; index += 1) {
      report(unattributableSource(index));
    }
    expect(warn).toHaveBeenCalledTimes(16);

    vi.setSystemTime(5 * 60_000 + 1_000);
    report(unattributableSource(16));
    report(unattributableSource(0));

    expect(warn).toHaveBeenCalledTimes(17);
  });

  it("resets source suppression when the wall clock moves backward", () => {
    const { warn, report, attribution } = warningFixture();

    vi.setSystemTime(4 * 60_000);
    report(attribution);
    vi.setSystemTime(2 * 60_000);
    report(attribution);
    report(attribution);
    expect(warn).toHaveBeenCalledTimes(2);

    vi.setSystemTime(7 * 60_000);
    report(attribution);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("bounds warnings from a flood of unique proxy sources", () => {
    const { warn, report } = warningFixture();

    for (let index = 0; index < 1_000; index += 1) {
      report(unattributableSource(index));
    }

    expect(warn).toHaveBeenCalledTimes(16);
  });
});
