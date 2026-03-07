import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  GatewayIntents,
  GatewayPlugin,
  HttpsProxyAgent,
  handleCloseSpy,
  handleReconnectSpy,
  handleZombieConnectionSpy,
  getLastAgent,
  proxyAgentSpy,
  resetLastAgent,
  webSocketSpy,
} = vi.hoisted(() => {
  const proxyAgentSpy = vi.fn();
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

  const handleCloseSpy = vi.fn();
  const handleZombieConnectionSpy = vi.fn();
  const handleReconnectSpy = vi.fn();

  class GatewayPlugin {
    options: unknown;
    constructor(options?: unknown) {
      this.options = options;
    }
    connect(_resume?: boolean) {}
    createWebSocket(url: string) {
      return { url };
    }
    handleClose(code: number) {
      handleCloseSpy(code);
    }
    handleZombieConnection() {
      handleZombieConnectionSpy();
    }
    handleReconnect() {
      handleReconnectSpy();
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
      proxyAgentSpy(proxyUrl);
    }
  }

  return {
    GatewayIntents,
    GatewayPlugin,
    HttpsProxyAgent,
    handleCloseSpy,
    handleReconnectSpy,
    handleZombieConnectionSpy,
    getLastAgent: () => HttpsProxyAgent.lastCreated,
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
    proxyAgentSpy.mockReset();
    webSocketSpy.mockReset();
    handleCloseSpy.mockReset();
    handleReconnectSpy.mockReset();
    handleZombieConnectionSpy.mockReset();
    resetLastAgent();
  });

  it("uses proxy agent for gateway WebSocket when configured", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "http://proxy.test:8080" },
      runtime,
    });

    expect(Object.getPrototypeOf(plugin)).not.toBe(GatewayPlugin.prototype);

    (plugin as unknown as { createWebSocket: (url: string) => unknown }).createWebSocket(
      "wss://gateway.discord.gg",
    );

    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(webSocketSpy).toHaveBeenCalledWith(
      "wss://gateway.discord.gg",
      expect.objectContaining({ agent: getLastAgent() }),
    );
    expect(runtime.log).toHaveBeenCalledWith("discord: gateway proxy enabled");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("falls back to the default gateway plugin when proxy is invalid", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: { proxy: "bad-proxy" },
      runtime,
    });

    expect(plugin).toBeInstanceOf(GatewayPlugin);
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("suppresses reconnect handlers during intentional shutdown", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    plugin.prepareForShutdown();
    (plugin as unknown as { handleClose: (code: number) => void }).handleClose(1006);
    (plugin as unknown as { handleZombieConnection: () => void }).handleZombieConnection();
    (plugin as unknown as { handleReconnect: () => void }).handleReconnect();

    expect(handleCloseSpy).not.toHaveBeenCalled();
    expect(handleZombieConnectionSpy).not.toHaveBeenCalled();
    expect(handleReconnectSpy).not.toHaveBeenCalled();
  });

  it("re-enables reconnect handlers after a new connect", async () => {
    const runtime = createRuntime();

    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime,
    });

    plugin.prepareForShutdown();
    plugin.connect(false);
    (plugin as unknown as { handleClose: (code: number) => void }).handleClose(1006);
    (plugin as unknown as { handleZombieConnection: () => void }).handleZombieConnection();
    (plugin as unknown as { handleReconnect: () => void }).handleReconnect();

    expect(handleCloseSpy).toHaveBeenCalledWith(1006);
    expect(handleZombieConnectionSpy).toHaveBeenCalledTimes(1);
    expect(handleReconnectSpy).toHaveBeenCalledTimes(1);
  });
});
