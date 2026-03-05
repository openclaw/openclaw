import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  GatewayIntents,
  baseRegisterClientSpy,
  GatewayPlugin,
  HttpsProxyAgent,
  getLastAgent,
  restProxyAgentSpy,
  undiciFetchMock,
  undiciProxyAgentSpy,
  resetLastAgent,
  webSocketSpy,
  wsProxyAgentSpy,
} = vi.hoisted(() => {
  const wsProxyAgentSpy = vi.fn();
  const undiciProxyAgentSpy = vi.fn();
  const restProxyAgentSpy = vi.fn();
  const undiciFetchMock = vi.fn();
  const baseRegisterClientSpy = vi.fn();
  const webSocketSpy = vi.fn();

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

  class GatewayPlugin {
    options: unknown;
    gatewayInfo: unknown;
    emitter = new EventEmitter();
    constructor(options?: unknown, gatewayInfo?: unknown) {
      this.options = options;
      this.gatewayInfo = gatewayInfo;
    }
    async registerClient(client: unknown) {
      baseRegisterClientSpy(client);
    }
  }

  class HttpsProxyAgent {
    static lastCreated: HttpsProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      if (proxyUrl === "bad-proxy") {
        throw new Error("bad proxy");
      }
      this.proxyUrl = proxyUrl;
      HttpsProxyAgent.lastCreated = this;
      wsProxyAgentSpy(proxyUrl);
    }
  }

  return {
    baseRegisterClientSpy,
    GatewayIntents,
    GatewayPlugin,
    HttpsProxyAgent,
    getLastAgent: () => HttpsProxyAgent.lastCreated,
    restProxyAgentSpy,
    undiciFetchMock,
    undiciProxyAgentSpy,
    resetLastAgent: () => {
      HttpsProxyAgent.lastCreated = undefined;
    },
    webSocketSpy,
    wsProxyAgentSpy,
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

vi.mock("undici", () => ({
  ProxyAgent: class {
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      undiciProxyAgentSpy(proxyUrl);
      restProxyAgentSpy(proxyUrl);
    }
  },
  fetch: undiciFetchMock,
}));

vi.mock("ws", () => ({
  default: class MockWebSocket {
    constructor(url: string, options?: { agent?: unknown }) {
      webSocketSpy(url, options);
    }
  },
}));

describe("createDiscordGatewayPlugin", () => {
  let createDiscordGatewayPlugin: typeof import("./gateway-plugin.js").createDiscordGatewayPlugin;

  beforeAll(async () => {
    ({ createDiscordGatewayPlugin } = await import("./gateway-plugin.js"));
  });

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
  }

  beforeEach(() => {
    baseRegisterClientSpy.mockClear();
    restProxyAgentSpy.mockClear();
    undiciFetchMock.mockClear();
    undiciProxyAgentSpy.mockClear();
    wsProxyAgentSpy.mockClear();
    webSocketSpy.mockClear();
    resetLastAgent();
  });

  it("uses proxy agent for gateway WebSocket when configured", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);

    const createWebSocket = (plugin as unknown as { createWebSocket: (url: string) => unknown })
      .createWebSocket;
    createWebSocket("wss://gateway.discord.gg");

    expect(wsProxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(webSocketSpy).toHaveBeenCalledWith(
      "wss://gateway.discord.gg",
      expect.objectContaining({ agent: getLastAgent() }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: gateway proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
    expect((plugin as { emitter?: EventEmitter }).emitter?.listenerCount("error")).toBeGreaterThan(
      0,
    );
    expect(() =>
      (plugin as { emitter?: EventEmitter }).emitter?.emit(
        "error",
        new Error("proxy mode fallback listener check"),
      ),
    ).not.toThrow();
  });

  it("falls back to the default gateway plugin when proxy is invalid", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "bad-proxy" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).toBe(GatewayPlugin.prototype);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect((plugin as { emitter?: EventEmitter }).emitter?.listenerCount("error")).toBeGreaterThan(
      0,
    );
    expect(() =>
      (plugin as { emitter?: EventEmitter }).emitter?.emit(
        "error",
        new Error("invalid proxy fallback listener check"),
      ),
    ).not.toThrow();
  });

  it("uses proxy fetch for gateway metadata lookup before registering", async () => {
    const runtime = createRuntime();
    undiciFetchMock.mockResolvedValue({
      json: async () => ({ url: "wss://gateway.discord.gg" }),
    } as Response);
    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime,
    });

    await (
      plugin as unknown as {
        registerClient: (client: { options: { token: string } }) => Promise<void>;
      }
    ).registerClient({
      options: { token: "token-123" },
    });

    expect(restProxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/gateway/bot",
      expect.objectContaining({
        headers: { Authorization: "Bot token-123" },
        dispatcher: expect.objectContaining({ proxyUrl: "http://proxy.test:8080" }),
      }),
    );
    expect(baseRegisterClientSpy).toHaveBeenCalledTimes(1);
  });

  it("attaches a fallback gateway error listener in default mode", () => {
    const runtime = createRuntime();
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    }) as unknown as { emitter?: EventEmitter };

    expect(plugin.emitter?.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      plugin.emitter?.emit(
        "error",
        new Error("Max reconnect attempts (0) reached after code 1006"),
      ),
    ).not.toThrow();
  });
});
