import { describe, expect, it, vi } from "vitest";
import { fetchConfiguredLocalOriginWithSsrFGuard, fetchWithSsrFGuard } from "./fetch-guard.js";

const GATEWAY_BASE = "http://host.containers.internal:11434";
const lookupFn = async () => [{ address: "169.254.1.2", family: 4 }];

describe("configured Podman origin capability", () => {
  it.each([
    ["without opt-in", GATEWAY_BASE, GATEWAY_BASE, false],
    ["for another hostname", "http://other.internal:11434", "http://other.internal:11434", true],
    ["for another port", GATEWAY_BASE, "http://host.containers.internal:11435", true],
    ["for another scheme", GATEWAY_BASE, "https://host.containers.internal:11434", true],
  ] as const)(
    "rejects link-local DNS %s",
    async (_label, configuredBase, requestedBase, enabled) => {
      const fetchImpl = vi.fn(async () => new Response("ok"));
      await expect(
        fetchConfiguredLocalOriginWithSsrFGuard({
          url: `${requestedBase}/api/embed`,
          configuredLocalOriginBaseUrl: configuredBase,
          allowPodmanHostGatewayLinkLocal: enabled,
          policy: { allowedOrigins: [configuredBase, requestedBase] },
          lookupFn,
          fetchImpl,
        }),
      ).rejects.toThrow("Blocked");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("preserves an operator hostname denial before DNS", async () => {
    const lookup = vi.fn(lookupFn);
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await expect(
      fetchConfiguredLocalOriginWithSsrFGuard({
        url: `${GATEWAY_BASE}/api/embed`,
        configuredLocalOriginBaseUrl: GATEWAY_BASE,
        allowPodmanHostGatewayLinkLocal: true,
        policy: {
          allowedOrigins: [GATEWAY_BASE],
          blockedHostnames: ["host.containers.internal"],
        },
        lookupFn: lookup,
        fetchImpl,
      }),
    ).rejects.toThrow("configured blocklist");
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not accept the private capability through the public guard", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await expect(
      fetchWithSsrFGuard({
        url: `${GATEWAY_BASE}/api/embed`,
        policy: { allowedOrigins: [GATEWAY_BASE] },
        lookupFn,
        fetchImpl,
        // @ts-expect-error - managedProxyBypass is intentionally not public
        managedProxyBypass: {
          kind: "configured-local-origin",
          baseUrl: GATEWAY_BASE,
          allowPodmanHostGatewayLinkLocal: true,
        },
      }),
    ).rejects.toThrow("Blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
