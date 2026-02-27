import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeDiscordProxyFetch, clearProxyAgentCache } from "./proxy.js";

const { undiciFetchMock, proxyAgentSpy } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(),
  proxyAgentSpy: vi.fn(),
}));

vi.mock("undici", () => {
  class ProxyAgent {
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      proxyAgentSpy(proxyUrl);
    }
  }
  return {
    ProxyAgent,
    fetch: undiciFetchMock,
  };
});

vi.mock("../infra/fetch.js", () => ({
  wrapFetchWithAbortSignal: vi.fn((fn) => fn),
}));

describe("makeDiscordProxyFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProxyAgentCache();
  });

  it("creates a fetch function that uses the proxy agent", async () => {
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const proxyFetch = makeDiscordProxyFetch("http://proxy.example.com:8080");

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.example.com:8080");

    const response = await proxyFetch("https://discord.com/api/v10/users/@me");

    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({
        dispatcher: expect.objectContaining({ proxyUrl: "http://proxy.example.com:8080" }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("supports HTTPS proxy URLs", async () => {
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const proxyFetch = makeDiscordProxyFetch("https://secure-proxy.example.com:443");

    expect(proxyAgentSpy).toHaveBeenCalledWith("https://secure-proxy.example.com:443");

    await proxyFetch("https://discord.com/api/v10/users/@me");

    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({
        dispatcher: expect.objectContaining({ proxyUrl: "https://secure-proxy.example.com:443" }),
      }),
    );
  });

  // Note: SOCKS5 is not supported by undici ProxyAgent (only http/https)
  // If SOCKS5 support is needed, consider using a different proxy library

  describe("proxy URL validation", () => {
    it("throws when given an invalid proxy URL format", () => {
      expect(() => makeDiscordProxyFetch("invalid-proxy")).toThrow("Invalid proxy URL");
    });

    it("throws when given an unsupported protocol", () => {
      expect(() => makeDiscordProxyFetch("ftp://proxy.example.com:21")).toThrow(
        "Invalid proxy protocol",
      );
    });

    it("throws when URL has no hostname", () => {
      expect(() => makeDiscordProxyFetch("http://")).toThrow();
    });

    it("accepts valid HTTP proxy URLs", () => {
      expect(() => makeDiscordProxyFetch("http://proxy.example.com:8080")).not.toThrow();
    });

    it("accepts valid HTTPS proxy URLs", () => {
      expect(() => makeDiscordProxyFetch("https://proxy.example.com:443")).not.toThrow();
    });

    it("rejects SOCKS5 proxy URLs (not supported by undici)", () => {
      expect(() => makeDiscordProxyFetch("socks5://proxy.example.com:1080")).toThrow(
        "Invalid proxy protocol",
      );
    });
  });

  describe("proxy authentication", () => {
    it("supports user:pass authentication in proxy URL", async () => {
      undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      const proxyFetch = makeDiscordProxyFetch("http://user:pass@proxy.example.com:8080");

      expect(proxyAgentSpy).toHaveBeenCalledWith("http://user:pass@proxy.example.com:8080");

      await proxyFetch("https://discord.com/api/v10/users/@me");

      expect(undiciFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/users/@me",
        expect.objectContaining({
          dispatcher: expect.objectContaining({
            proxyUrl: "http://user:pass@proxy.example.com:8080",
          }),
        }),
      );
    });

    it("supports username-only authentication in proxy URL", async () => {
      undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      const _proxyFetch = makeDiscordProxyFetch("http://user@proxy.example.com:8080");

      expect(proxyAgentSpy).toHaveBeenCalledWith("http://user@proxy.example.com:8080");
    });

    it("supports special characters in password", async () => {
      undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      const _proxyFetch = makeDiscordProxyFetch("http://user:p%40ss%3Aword@proxy.example.com:8080");

      expect(proxyAgentSpy).toHaveBeenCalledWith(
        "http://user:p%40ss%3Aword@proxy.example.com:8080",
      );
    });
  });

  describe("connection pooling", () => {
    it("reuses ProxyAgent for same proxy URL (connection pooling)", () => {
      const proxyUrl = "http://proxy.example.com:8080";

      makeDiscordProxyFetch(proxyUrl);
      makeDiscordProxyFetch(proxyUrl);
      makeDiscordProxyFetch(proxyUrl);

      // Should only create one ProxyAgent for the same URL
      expect(proxyAgentSpy).toHaveBeenCalledTimes(1);
      expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    });

    it("creates separate ProxyAgents for different proxy hosts", () => {
      makeDiscordProxyFetch("http://proxy1.example.com:8080");
      makeDiscordProxyFetch("http://proxy2.example.com:8080");

      expect(proxyAgentSpy).toHaveBeenCalledTimes(2);
    });

    it("creates separate ProxyAgents for different auth credentials (cache key includes full URL)", () => {
      // The cache key includes the full URL including auth credentials
      // This ensures different accounts with different credentials get separate agents
      makeDiscordProxyFetch("http://user1:pass1@proxy.example.com:8080");
      makeDiscordProxyFetch("http://user2:pass2@proxy.example.com:8080");

      // Each unique URL (including auth) gets its own ProxyAgent
      expect(proxyAgentSpy).toHaveBeenCalledTimes(2);
      expect(proxyAgentSpy).toHaveBeenCalledWith("http://user1:pass1@proxy.example.com:8080");
      expect(proxyAgentSpy).toHaveBeenCalledWith("http://user2:pass2@proxy.example.com:8080");
    });

    it("clearProxyAgentCache allows creating fresh agents", () => {
      const proxyUrl = "http://proxy.example.com:8080";

      makeDiscordProxyFetch(proxyUrl);
      expect(proxyAgentSpy).toHaveBeenCalledTimes(1);

      clearProxyAgentCache();

      makeDiscordProxyFetch(proxyUrl);
      expect(proxyAgentSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("passes through request init options", async () => {
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const proxyFetch = makeDiscordProxyFetch("http://proxy.example.com:8080");

    const headers = new Headers({ Authorization: "Bot test-token" });
    await proxyFetch("https://discord.com/api/v10/users/@me", {
      method: "GET",
      headers,
    });

    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({
        method: "GET",
        headers,
        dispatcher: expect.any(Object),
      }),
    );
  });

  it("passes through POST request with body", async () => {
    undiciFetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "123" }), { status: 200 }));

    const proxyFetch = makeDiscordProxyFetch("http://proxy.example.com:8080");

    await proxyFetch("https://discord.com/api/v10/channels/123/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello" }),
    });

    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/123/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "Hello" }),
        dispatcher: expect.any(Object),
      }),
    );
  });

  it("handles non-OK responses", async () => {
    undiciFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
    );

    const proxyFetch = makeDiscordProxyFetch("http://proxy.example.com:8080");

    const response = await proxyFetch("https://discord.com/api/v10/users/@me");

    expect(response.status).toBe(401);
    expect(response.ok).toBe(false);
  });

  it("handles network errors", async () => {
    undiciFetchMock.mockRejectedValue(new Error("Network error"));

    const proxyFetch = makeDiscordProxyFetch("http://proxy.example.com:8080");

    await expect(proxyFetch("https://discord.com/api/v10/users/@me")).rejects.toThrow(
      "Network error",
    );
  });

  it("returns a function that can be called multiple times", async () => {
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const proxyFetch = makeDiscordProxyFetch("http://proxy.example.com:8080");

    await proxyFetch("https://discord.com/api/v10/users/@me");
    await proxyFetch("https://discord.com/api/v10/guilds");
    await proxyFetch("https://discord.com/api/v10/channels");

    expect(undiciFetchMock).toHaveBeenCalledTimes(3);
  });

  it("supports AbortSignal in request init", async () => {
    undiciFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      // Simulate abort handling
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return new Response("ok", { status: 200 });
    });

    const proxyFetch = makeDiscordProxyFetch("http://proxy.example.com:8080");
    const controller = new AbortController();

    // Abort immediately
    controller.abort();

    await expect(
      proxyFetch("https://discord.com/api/v10/users/@me", { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
