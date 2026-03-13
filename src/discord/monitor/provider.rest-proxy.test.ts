import { describe, expect, it, vi } from "vitest";
import { resolveDiscordRestFetch } from "./rest-fetch.js";

const { undiciFetchMock, envHttpProxyAgentSpy } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(),
  envHttpProxyAgentSpy: vi.fn(),
}));

vi.mock("undici", () => {
  class EnvHttpProxyAgent {
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
    constructor(opts: { httpProxy: string; httpsProxy: string; noProxy: string }) {
      if (opts.httpProxy === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.httpProxy = opts.httpProxy;
      this.httpsProxy = opts.httpsProxy;
      this.noProxy = opts.noProxy;
      envHttpProxyAgentSpy(opts);
    }
  }
  return {
    EnvHttpProxyAgent,
    fetch: undiciFetchMock,
  };
});

describe("resolveDiscordRestFetch", () => {
  it("uses undici proxy fetch when a proxy URL is configured", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockClear().mockResolvedValue(new Response("ok", { status: 200 }));
    envHttpProxyAgentSpy.mockClear();
    const fetcher = resolveDiscordRestFetch("http://proxy.test:8080", runtime);

    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    expect(envHttpProxyAgentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        httpProxy: "http://proxy.test:8080",
        httpsProxy: "http://proxy.test:8080",
      }),
    );
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/applications/@me",
      expect.objectContaining({
        dispatcher: expect.objectContaining({
          httpProxy: "http://proxy.test:8080",
        }),
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
