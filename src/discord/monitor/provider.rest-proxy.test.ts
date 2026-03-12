import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDiscordRestFetch } from "./rest-fetch.js";

const { globalFetchMock, proxyAgentSpy } = vi.hoisted(() => ({
  globalFetchMock: vi.fn(),
  proxyAgentSpy: vi.fn(),
}));

vi.mock("undici", () => {
  class ProxyAgent {
    proxyUrl: string;
    constructor(proxyUrl: string) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      proxyAgentSpy(proxyUrl);
    }
  }
  return {
    ProxyAgent,
  };
});

describe("resolveDiscordRestFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses global fetch with dispatcher when a proxy URL is configured", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    globalFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const fetcher = resolveDiscordRestFetch("http://proxy.test:8080", runtime);

    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    const request = globalFetchMock.mock.calls[0]?.[0] as Request;
    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(request).toBeInstanceOf(Request);
    expect(request.url).toBe("https://discord.com/api/v10/oauth2/applications/@me");
    expect(globalFetchMock).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        dispatcher: expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: rest proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to global fetch when proxy URL is invalid", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    const fetcher = resolveDiscordRestFetch("bad-proxy", runtime);

    expect(fetcher).toBe(fetch);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
