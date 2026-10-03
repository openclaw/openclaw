import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "./ssrf.js";

type LookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

const ORIGIN = "http://host.containers.internal:8081";

function lookupTo(address: string): LookupFn {
  return vi.fn(async () => [{ address, family: 4 }]) as unknown as LookupFn;
}

function okFetch() {
  return vi.fn(async () => new Response("{}", { status: 200 }));
}

describe("fetchWithSsrFGuard exact-origin policy with allowPrivateNetwork", () => {
  it("blocks a link-local answer for the configured origin without the opt-in", async () => {
    const fetchImpl = okFetch();
    await expect(
      fetchWithSsrFGuard({
        url: `${ORIGIN}/health`,
        fetchImpl,
        lookupFn: lookupTo("169.254.1.2"),
        policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(ORIGIN),
      }),
    ).rejects.toThrow("private/internal/special-use IP address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows a link-local answer for the configured origin with the opt-in", async () => {
    const fetchImpl = okFetch();
    const result = await fetchWithSsrFGuard({
      url: `${ORIGIN}/health`,
      fetchImpl,
      lookupFn: lookupTo("169.254.1.2"),
      policy: { ...ssrfPolicyFromHttpBaseUrlAllowedOrigin(ORIGIN), allowPrivateNetwork: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it("refuses to follow a redirect from the configured origin to a metadata address when redirects are disabled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
      );
    await expect(
      fetchWithSsrFGuard({
        url: `${ORIGIN}/health`,
        fetchImpl,
        lookupFn: lookupTo("169.254.1.2"),
        maxRedirects: 0,
        policy: { ...ssrfPolicyFromHttpBaseUrlAllowedOrigin(ORIGIN), allowPrivateNetwork: true },
      }),
    ).rejects.toThrow(/redirect/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends no request to a redirect destination over real HTTP when redirects are disabled", async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.end("{}");
    });
    const listen = (server: Server) =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
    const targetPort = await listen(target);
    const source = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/latest` });
      res.end();
    });
    const sourcePort = await listen(source);
    const sourceOrigin = `http://127.0.0.1:${sourcePort}`;
    try {
      await expect(
        fetchWithSsrFGuard({
          url: `${sourceOrigin}/health`,
          maxRedirects: 0,
          policy: {
            ...ssrfPolicyFromHttpBaseUrlAllowedOrigin(sourceOrigin),
            allowPrivateNetwork: true,
          },
        }),
      ).rejects.toThrow(/redirect/i);
      expect(targetHits).toBe(0);
    } finally {
      source.close();
      target.close();
    }
  });
});
