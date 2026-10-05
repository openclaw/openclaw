import { describe, expect, it, vi } from "vitest";
import { fetchConfiguredLocalOriginWithSsrFGuard } from "./fetch-guard.js";
import type { LookupFn, SsrFPolicy } from "./ssrf.js";

// OrbStack resolves host.docker.internal into nonzero 0.0.0.0/8.
const configuredOrigin = "http://host.docker.internal:11434";

const lookupTo = (address: string, family: 4 | 6): LookupFn =>
  vi.fn(async () => [{ address, family }]) as unknown as LookupFn;

function fetchConfiguredOrigin(params: {
  lookupFn: LookupFn;
  fetchImpl: () => Promise<Response>;
  allowUnspecifiedIpv4Range?: boolean;
  policy?: SsrFPolicy;
}) {
  return fetchConfiguredLocalOriginWithSsrFGuard({
    url: `${configuredOrigin}/api/embed`,
    fetchImpl: params.fetchImpl,
    lookupFn: params.lookupFn,
    policy: params.policy ?? { allowedOrigins: [configuredOrigin] },
    configuredLocalOriginBaseUrl: configuredOrigin,
    allowUnspecifiedIpv4Range: params.allowUnspecifiedIpv4Range,
  });
}

describe("configured-origin unspecified IPv4 exemption", () => {
  it("reaches a configured origin that resolves into nonzero 0.0.0.0/8 when opted in", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));

    const result = await fetchConfiguredOrigin({
      lookupFn: lookupTo("0.250.250.254", 4),
      fetchImpl,
      allowUnspecifiedIpv4Range: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it.each([
    ["without the opt-in", "0.250.250.254", 4, undefined],
    ["for literal 0.0.0.0", "0.0.0.0", 4, true],
    ["for IPv4-mapped IPv6 0.0.0.0", "::ffff:0.0.0.0", 6, true],
    ["for link-local metadata", "169.254.169.254", 4, true],
  ] as const)("still blocks the configured origin %s", async (_name, address, family, optIn) => {
    const fetchImpl = vi.fn(async () => new Response("ok"));

    await expect(
      fetchConfiguredOrigin({
        lookupFn: lookupTo(address, family),
        fetchImpl,
        allowUnspecifiedIpv4Range: optIn,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not carry the exemption to a redirect on another trusted origin", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://other.internal:11434/api/embed" },
        }),
    );

    await expect(
      fetchConfiguredOrigin({
        lookupFn: lookupTo("0.250.250.254", 4),
        fetchImpl,
        allowUnspecifiedIpv4Range: true,
        policy: { allowedOrigins: [configuredOrigin], allowedHostnames: ["other.internal"] },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
