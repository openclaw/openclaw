import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  GatewayIntents,
  baseRegisterClientSpy,
  GatewayPlugin,
  HttpsProxyAgent,
  undiciFetchMock,
  undiciProxyAgentSpy,
  webSocketSpy,
  wsProxyAgentSpy,
  resetLastAgent,
} = vi.hoisted(() => {
  const wsProxyAgentSpy = vi.fn();
  const undiciProxyAgentSpy = vi.fn();
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
    GuildVoiceStates: 1 << 8,
  } as const;

  class GatewayPlugin {
    options: unknown;
    gatewayInfo: unknown;
    constructor(options?: unknown, gatewayInfo?: unknown) {
      this.options = options;
      this.gatewayInfo = gatewayInfo;
    }
    async registerClient(client: unknown) {
      return baseRegisterClientSpy(client);
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
    undiciFetchMock,
    undiciProxyAgentSpy,
    resetLastAgent: () => {
      HttpsProxyAgent.lastCreated = undefined;
    },
    webSocketSpy,
    wsProxyAgentSpy,
  };
});

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

type TestablePlugin = {
  registerClient: (client: { options: { token: string } }) => Promise<void>;
  gatewayInfo: unknown;
};

/** Check that runtime.error was called with a string containing `needle` (ignoring ANSI codes). */
function expectErrorContaining(runtime: { error: ReturnType<typeof vi.fn> }, needle: string) {
  const calls = runtime.error.mock.calls;
  const found = calls.some((args: unknown[]) => {
    // eslint-disable-next-line no-control-regex
    const raw = String(args[0]).replace(/\u001b\[[^m]*m/g, "");
    return raw.includes(needle);
  });
  expect(found, `Expected runtime.error to be called with message containing "${needle}"`).toBe(
    true,
  );
}

function expectNoError(runtime: { error: ReturnType<typeof vi.fn> }) {
  expect(runtime.error).not.toHaveBeenCalled();
}

describe("gateway-plugin crash guard (#34592)", () => {
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

  const fakeClient = { options: { token: "test-token" } };

  beforeEach(() => {
    baseRegisterClientSpy.mockClear();
    baseRegisterClientSpy.mockReset();
    undiciFetchMock.mockClear();
    undiciFetchMock.mockReset();
    undiciProxyAgentSpy.mockClear();
    wsProxyAgentSpy.mockClear();
    webSocketSpy.mockClear();
    resetLastAgent();
  });

  describe("no proxy (SafeGatewayPlugin)", () => {
    it("does not throw when super.registerClient rejects", async () => {
      baseRegisterClientSpy.mockRejectedValue(new Error("fetch failed"));
      const runtime = createRuntime();
      const plugin = createDiscordGatewayPlugin({
        discordConfig: {},
        runtime,
      }) as unknown as TestablePlugin;

      // Should not throw — rejection is caught internally
      await plugin.registerClient(fakeClient);

      expectErrorContaining(runtime, "gateway registerClient failed");
    });

    it("works normally when super.registerClient succeeds", async () => {
      const runtime = createRuntime();
      const plugin = createDiscordGatewayPlugin({
        discordConfig: {},
        runtime,
      }) as unknown as TestablePlugin;

      await plugin.registerClient(fakeClient);

      expect(baseRegisterClientSpy).toHaveBeenCalledWith(fakeClient);
      expectNoError(runtime);
    });
  });

  describe("with proxy (ProxyGatewayPlugin)", () => {
    it("falls back to default gateway info when proxy fetch fails", async () => {
      undiciFetchMock.mockRejectedValue(new Error("network unreachable"));
      const runtime = createRuntime();
      const plugin = createDiscordGatewayPlugin({
        discordConfig: { proxy: "http://proxy.test:8080" },
        runtime,
      }) as unknown as TestablePlugin;

      await plugin.registerClient(fakeClient);

      expectErrorContaining(runtime, "failed to fetch gateway info via proxy");
      expect(plugin.gatewayInfo).toEqual(
        expect.objectContaining({
          url: "wss://gateway.discord.gg/",
          shards: 1,
        }),
      );
      expect(baseRegisterClientSpy).toHaveBeenCalledWith(fakeClient);
    });

    it("does not throw when both proxy fetch and super.registerClient fail", async () => {
      undiciFetchMock.mockRejectedValue(new Error("network unreachable"));
      baseRegisterClientSpy.mockRejectedValue(new Error("connect failed"));
      const runtime = createRuntime();
      const plugin = createDiscordGatewayPlugin({
        discordConfig: { proxy: "http://proxy.test:8080" },
        runtime,
      }) as unknown as TestablePlugin;

      // Should not throw
      await plugin.registerClient(fakeClient);

      expectErrorContaining(runtime, "failed to fetch gateway info via proxy");
      expectErrorContaining(runtime, "gateway registerClient failed");
    });

    it("works normally when proxy fetch succeeds", async () => {
      undiciFetchMock.mockResolvedValue({
        json: async () => ({ url: "wss://gateway.discord.gg/" }),
      });
      const runtime = createRuntime();
      const plugin = createDiscordGatewayPlugin({
        discordConfig: { proxy: "http://proxy.test:8080" },
        runtime,
      }) as unknown as TestablePlugin;

      await plugin.registerClient(fakeClient);

      expect(baseRegisterClientSpy).toHaveBeenCalledWith(fakeClient);
      expectNoError(runtime);
    });
  });

  describe("invalid proxy fallback", () => {
    it("returns SafeGatewayPlugin that catches registerClient errors", async () => {
      baseRegisterClientSpy.mockRejectedValue(new Error("kaboom"));
      const runtime = createRuntime();
      const plugin = createDiscordGatewayPlugin({
        discordConfig: { proxy: "bad-proxy" },
        runtime,
      }) as unknown as TestablePlugin;

      // Should not throw even when super rejects
      await plugin.registerClient(fakeClient);

      expectErrorContaining(runtime, "invalid gateway proxy");
      expectErrorContaining(runtime, "gateway registerClient failed");
    });
  });
});
