import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("gaxios fetch compat", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses native fetch without defining window or importing node-fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("node-fetch", () => {
      throw new Error("node-fetch should not load");
    });

    const { installGaxiosFetchCompat } = await import("./gaxios-fetch-compat.js");
    const { Gaxios } = await import("gaxios");

    installGaxiosFetchCompat();

    const res = await new Gaxios().request({
      responseType: "text",
      url: "https://example.com",
    });

    expect(res.data).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect("window" in globalThis).toBe(false);
  });

  it("translates proxy agents into undici dispatchers for native fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    });
    const { createGaxiosCompatFetch } = await import("./gaxios-fetch-compat.js");

    const compatFetch = createGaxiosCompatFetch(fetchMock);
    await compatFetch("https://example.com", {
      agent: new HttpsProxyAgent("http://proxy.example:8080"),
    } as RequestInit);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];

    expect(init).not.toHaveProperty("agent");
    expect((init as { dispatcher?: unknown })?.dispatcher).toBeInstanceOf(ProxyAgent);
  });
});
