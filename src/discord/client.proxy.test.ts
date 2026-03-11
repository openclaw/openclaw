import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { makeProxyFetch, proxyFetch } = vi.hoisted(() => {
  const proxyFetch = vi.fn();
  return {
    makeProxyFetch: vi.fn(() => proxyFetch as typeof fetch),
    proxyFetch,
  };
});

vi.mock("../infra/net/proxy-fetch.js", () => ({
  makeProxyFetch,
}));

import { createDiscordRestClient } from "./client.js";

describe("createDiscordRestClient proxy support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes outbound Discord REST sends through the configured proxy fetch", async () => {
    const globalFetch = vi.fn();
    globalFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "global-fetch-should-not-run" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", globalFetch);
    proxyFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "message-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    const { rest } = createDiscordRestClient({}, cfg);
    const result = await rest.post("/channels/123/messages", {
      body: { content: "hello" },
    });

    expect(makeProxyFetch).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(proxyFetch).toHaveBeenCalledWith(
      "https://discord.com/api/channels/123/messages",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    const init = proxyFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get("Authorization")).toBe("Bot test-token");
    expect(init.body).toBe(JSON.stringify({ content: "hello" }));
    expect(globalFetch).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "message-1" });
  });
});
