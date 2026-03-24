import { afterEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../../infra/net/ssrf.js";
import * as webGuardedFetch from "./web-guarded-fetch.js";
import { createWebFetchTool } from "./web-tools.js";

function createTool() {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            firecrawl: { enabled: false },
          },
        },
      },
    },
  });
}

function createCachingTool() {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 10,
            firecrawl: { enabled: false },
          },
        },
      },
    },
  });
}

describe("web_fetch transport retry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses strict transport by default for normal requests", async () => {
    const fetchSpy = vi.spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard").mockResolvedValue({
      response: new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
      finalUrl: "https://example.com/ok",
      release: async () => {},
    });

    const tool = createTool();
    await tool?.execute?.("call", { url: "https://example.com/ok" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        useEnvProxy: false,
      }),
    );
  });

  it("retries with env-proxy only after strict SSRF block on hostname when proxy env is set", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const fetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockRejectedValueOnce(
        new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
      )
      .mockResolvedValueOnce({
        response: new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        finalUrl: "https://proxy-fake-ip.test/resource",
        release: async () => {},
      });

    const tool = createTool();
    const result = await tool?.execute?.("call", { url: "https://proxy-fake-ip.test/resource" });

    expect(result?.details).toMatchObject({ status: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ useEnvProxy: false }));
    expect(fetchSpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ useEnvProxy: true }));
  });

  it("does not retry literal IP targets even when proxy env is set", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const fetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockRejectedValue(
        new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
      );

    const tool = createTool();
    await expect(tool?.execute?.("call", { url: "https://198.18.0.153/resource" })).rejects.toThrow(
      /blocked|private|internal/i,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ useEnvProxy: false }));
  });

  it("does not retry strict SSRF block when proxy env is not configured", async () => {
    const fetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockRejectedValue(
        new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
      );

    const tool = createTool();
    await expect(
      tool?.execute?.("call", { url: "https://proxy-fake-ip.test/resource" }),
    ).rejects.toThrow(/blocked|private|internal/i);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ useEnvProxy: false }));
  });

  it("does not retry when only ALL_PROXY is configured", async () => {
    vi.stubEnv("ALL_PROXY", "socks5://127.0.0.1:1080");
    const fetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockRejectedValue(
        new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
      );

    const tool = createTool();
    await expect(
      tool?.execute?.("call", { url: "https://proxy-fake-ip.test/resource" }),
    ).rejects.toThrow(/blocked|private|internal/i);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ useEnvProxy: false }));
  });

  it("does not retry when NO_PROXY bypasses env proxy for the hostname", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    vi.stubEnv("NO_PROXY", "proxy-fake-ip.test");
    const fetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockRejectedValue(
        new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
      );

    const tool = createTool();
    await expect(
      tool?.execute?.("call", { url: "https://proxy-fake-ip.test/resource" }),
    ).rejects.toThrow(/blocked|private|internal/i);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ useEnvProxy: false }));
  });

  it("does not reuse cached proxy-route results after NO_PROXY state changes", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const fetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockRejectedValueOnce(
        new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
      )
      .mockResolvedValueOnce({
        response: new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        finalUrl: "https://proxy-cache-state.test/resource",
        release: async () => {},
      })
      .mockRejectedValueOnce(
        new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
      );

    const tool = createCachingTool();
    const url = "https://proxy-cache-state.test/resource";

    const first = await tool?.execute?.("call", { url });
    expect(first?.details).toMatchObject({ status: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.stubEnv("NO_PROXY", "proxy-cache-state.test");
    await expect(tool?.execute?.("call", { url })).rejects.toThrow(/blocked|private|internal/i);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ useEnvProxy: false }));
  });

  it("invalidates cache when NO_PROXY changes only for a redirected hop host", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const fetchSpy = vi
      .spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard")
      .mockResolvedValueOnce({
        response: new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
        finalUrl: "https://redirected-proxy-hop.test/resource",
        release: async () => {},
      })
      .mockRejectedValueOnce(new Error("should refetch after NO_PROXY change"));

    const tool = createCachingTool();
    const url = "https://entry-proxy-hop.test/resource";

    const first = await tool?.execute?.("call", { url });
    expect(first?.details).toMatchObject({ status: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.stubEnv("NO_PROXY", "redirected-proxy-hop.test");
    await expect(tool?.execute?.("call", { url })).rejects.toThrow(
      /should refetch after NO_PROXY change/i,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
