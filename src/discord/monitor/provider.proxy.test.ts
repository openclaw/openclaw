import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  GatewayIntents,
  GatewayPlugin,
  HttpsProxyAgent,
  getLastAgent,
  getLookup,
  getLookupMock,
  proxyAgentSpy,
  resetLastAgent,
  webSocketSpy,
} = vi.hoisted(() => {
  const proxyAgentSpy = vi.fn();
  const webSocketSpy = vi.fn();
  const lookupFn = vi.fn();
  const getLookup = () => lookupFn;
  const getLookupMock = () => lookupFn;

  const GatewayIntents = {
    Guilds: 1 << 0,
    GuildMessages: 1 << 1,
    MessageContent: 1 << 2,
    DirectMessages: 1 << 3,
    GuildMessageReactions: 1 << 4,
    DirectMessageReactions: 1 << 5,
    GuildPresences: 1 << 6,
    GuildMembers: 1 << 7,
  } as const;

  class GatewayPlugin {}

  class HttpsProxyAgent {
    static lastCreated: HttpsProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      HttpsProxyAgent.lastCreated = this;
      proxyAgentSpy(proxyUrl);
    }
  }

  return {
    GatewayIntents,
    GatewayPlugin,
    HttpsProxyAgent,
    getLastAgent: () => HttpsProxyAgent.lastCreated,
    getLookup,
    getLookupMock,
    proxyAgentSpy,
    resetLastAgent: () => {
      HttpsProxyAgent.lastCreated = undefined;
    },
    webSocketSpy,
  };
});

// Unit test: don't import Carbon just to check the prototype chain.
vi.mock("@buape/carbon/gateway", () => ({
  GatewayIntents,
  GatewayPlugin,
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent,
}));

vi.mock("ws", () => ({
  default: class MockWebSocket {
    constructor(url: string, options?: { agent?: unknown }) {
      webSocketSpy(url, options);
    }
  },
}));

const { createDiscordDnsLookup } = vi.hoisted(() => ({
  createDiscordDnsLookup: vi.fn(() => getLookupMock()),
}));
vi.mock("../network-config.js", () => ({
  createDiscordDnsLookup,
}));

describe("createDiscordGatewayPlugin", () => {
  beforeEach(() => {
    proxyAgentSpy.mockReset();
    getLookupMock().mockClear();
    webSocketSpy.mockReset();
    resetLastAgent();
  });

  it("uses IPv4-first lookup for gateway websocket when no proxy is configured", async () => {
    const { createDiscordGatewayPlugin } = await import("./gateway-plugin.js");

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };

    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");

    expect(webSocketSpy).toHaveBeenCalledWith(
      "wss://gateway.discord.gg",
      expect.objectContaining({ lookup: getLookup() }),
    );
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("uses proxy agent for gateway WebSocket when configured", async () => {
    const { createDiscordGatewayPlugin } = await import("./gateway-plugin.js");

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(webSocketSpy).toHaveBeenCalledWith(
      "wss://gateway.discord.gg",
      expect.objectContaining({ agent: getLastAgent(), lookup: getLookup() }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: gateway proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to the default gateway plugin when proxy is invalid", async () => {
    const { createDiscordGatewayPlugin } = await import("./gateway-plugin.js");

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "bad-proxy" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).toBe(GatewayPlugin.prototype);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
