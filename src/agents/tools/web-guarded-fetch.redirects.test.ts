import { afterEach, describe, expect, it, vi } from "vitest";
import { withSelfHostedWebToolsEndpoint } from "./web-guarded-fetch.js";

afterEach(() => vi.unstubAllEnvs());

describe("self-hosted web endpoint redirects", () => {
  it.each([false, true])(
    "confines redirects to the endpoint host (env proxy: %s)",
    async (proxy) => {
      vi.stubEnv("HTTP_PROXY", proxy ? "http://proxy.test:8080" : "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubEnv("ALL_PROXY", "");
      vi.stubEnv("NO_PROXY", "");
      const url = "http://search.test:8080/search";
      const lookupFn = vi.fn(async () => [{ address: "10.0.0.10", family: 4 }]);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/next" } }))
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "http://other.test/result" } }),
        )
        .mockResolvedValue(new Response("unexpected response"));
      const run = vi.fn(async ({ response }: { response: Response }) => response.text());

      await expect(
        withSelfHostedWebToolsEndpoint({ url, lookupFn, fetchImpl, capture: false }, run),
      ).rejects.toThrow(/not in allowlist/i);
      expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([
        url,
        "http://search.test:8080/next",
      ]);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(["http://search.test:8080", "http://127.0.0.1:8080", "http://[::1]:8080"])(
    "allows the configured private endpoint and same-host redirects: %s",
    async (base) => {
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubEnv("ALL_PROXY", "");
      const lookupFn = vi.fn(async () => [{ address: "10.0.0.10", family: 4 }]);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/next" } }))
        .mockResolvedValue(new Response("endpoint result"));
      await expect(
        withSelfHostedWebToolsEndpoint(
          { url: `${base}/search`, lookupFn, fetchImpl, capture: false },
          async ({ response, finalUrl }) => ({ text: await response.text(), finalUrl }),
        ),
      ).resolves.toEqual({ text: "endpoint result", finalUrl: `${base}/next` });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});
