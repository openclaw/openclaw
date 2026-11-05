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
  return { warn, report };
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

  it.each<{
    name: string;
    steps: Array<[time: number, sources: number[], warnings: number]>;
  }>([
    {
      name: "does not refresh suppression under continuous traffic",
      steps: Array.from({ length: 7 }, (_, minute) => [minute * 60_000, [10], minute < 5 ? 1 : 2]),
    },
    {
      name: "retains late-window sources across the next budget",
      steps: [
        [299_000, Array.from({ length: 16 }, (_, i) => i), 16],
        [301_000, [16, 0], 17],
      ],
    },
    {
      name: "resets suppression on clock rollback",
      steps: [
        [240_000, [10], 1],
        [120_000, [10, 10], 2],
        [420_000, [10], 3],
      ],
    },
    {
      name: "bounds a flood of unique sources",
      steps: [[0, Array.from({ length: 1_000 }, (_, i) => i), 16]],
    },
  ])("$name", ({ steps }) => {
    const { warn, report } = warningFixture();
    for (const [time, sources, warnings] of steps) {
      vi.setSystemTime(time);
      sources.forEach((index) => report(unattributableSource(index)));
      expect(warn).toHaveBeenCalledTimes(warnings);
    }
  });
});
