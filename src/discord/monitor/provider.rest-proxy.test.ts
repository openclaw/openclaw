import { describe, expect, it, vi } from "vitest";

const { Agent, undiciFetchMock, proxyAgentSpy, getLastAgent } = vi.hoisted(() => {
  const undiciFetchMock = vi.fn();
  const proxyAgentSpy = vi.fn();
  let lastAgent: { connect?: { lookup?: unknown } } | undefined;
  class Agent {
    connect: { lookup?: unknown };
    constructor(opts?: { connect?: { lookup?: unknown } }) {
      this.connect = opts?.connect ?? {};
      lastAgent = { connect: this.connect };
    }
  }
  return {
    Agent,
    undiciFetchMock,
    proxyAgentSpy,
    getLastAgent: () => lastAgent,
  };
});

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
    Agent,
    fetch: undiciFetchMock,
  };
});

describe("resolveDiscordRestFetch", () => {
  it("uses undici fetch with a Discord DNS lookup dispatcher when no proxy is configured", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    const last = getLastAgent;
    undiciFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const { __testing } = await import("./provider.js");
    const fetcher = __testing.resolveDiscordRestFetch(undefined, runtime);

    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    expect(last()).toEqual(
      expect.objectContaining({
        connect: expect.objectContaining({
          lookup: expect.any(Function),
        }),
      }),
    );
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/applications/@me",
      expect.objectContaining({
        dispatcher: expect.objectContaining({
          connect: expect.objectContaining({
            lookup: expect.any(Function),
          }),
        }),
      }),
    );
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("uses undici proxy fetch when a proxy URL is configured", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as const;
    undiciFetchMock.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
    proxyAgentSpy.mockReset();

    const { __testing } = await import("./provider.js");
    const fetcher = __testing.resolveDiscordRestFetch("http://proxy.test:8080", runtime);

    await fetcher("https://discord.com/api/v10/oauth2/applications/@me");

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/applications/@me",
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
    const { __testing } = await import("./provider.js");

    const fetcher = __testing.resolveDiscordRestFetch("bad-proxy", runtime);

    expect(fetcher).toBe(fetch);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
