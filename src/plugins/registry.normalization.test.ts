import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

const mockRuntime: PluginRuntime = {
  config: {},
  env: {},
  createLogger: vi.fn(),
  getAgent: vi.fn(),
  session: vi.fn(),
  subagent: vi.fn(),
} as unknown as PluginRuntime;

vi.mock("./runtime/gateway-request-scope.js", () => ({
  withPluginRuntimePluginIdScope: vi.fn((_id, fn) => fn()),
}));

describe("plugin registry normalization", () => {
  let registry: ReturnType<typeof createEmptyPluginRegistry>;
  let createApi: ReturnType<typeof import("./registry.js").createPluginRegistry>["createApi"];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./registry.js");
    const result = mod.createPluginRegistry({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      runtime: mockRuntime,
    });
    registry = result.registry;
    createApi = result.createApi;
  });

  describe("provider registration normalization", () => {
    it("normalizes provider ID to lowercase during registration", () => {
      const record = {
        id: "test-plugin",
        name: "Test Plugin",
        source: "/test/index.ts",
        origin: "bundled" as const,
        enabled: true,
        status: "loaded" as const,
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        speechProviderIds: [],
        mediaUnderstandingProviderIds: [],
        imageGenerationProviderIds: [],
        webSearchProviderIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpRoutes: 0,
        hookCount: 0,
        configSchema: false,
      };

      const api = createApi(record, { config: {} });

      api.registerProvider({
        id: " OpenAI ",
        label: "OpenAI",
        auth: [],
      });

      const provider = registry.providers.find((p) => p.provider.id === "openai");
      expect(provider).toBeDefined();
      expect(provider?.provider.id).toBe("openai");
    });

    it("normalizes z.ai alias to zai during registration", () => {
      const record = {
        id: "test-plugin",
        name: "Test Plugin",
        source: "/test/index.ts",
        origin: "bundled" as const,
        enabled: true,
        status: "loaded" as const,
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        speechProviderIds: [],
        mediaUnderstandingProviderIds: [],
        imageGenerationProviderIds: [],
        webSearchProviderIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpRoutes: 0,
        hookCount: 0,
        configSchema: false,
      };

      const api = createApi(record, { config: {} });

      api.registerProvider({
        id: "z.ai",
        label: "ZAI",
        auth: [],
      });

      const provider = registry.providers.find((p) => p.provider.id === "zai");
      expect(provider).toBeDefined();
      expect(provider?.provider.id).toBe("zai");
    });

    it("normalizes qwen to qwen-portal during registration", () => {
      const record = {
        id: "test-plugin",
        name: "Test Plugin",
        source: "/test/index.ts",
        origin: "bundled" as const,
        enabled: true,
        status: "loaded" as const,
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        speechProviderIds: [],
        mediaUnderstandingProviderIds: [],
        imageGenerationProviderIds: [],
        webSearchProviderIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpRoutes: 0,
        hookCount: 0,
        configSchema: false,
      };

      const api = createApi(record, { config: {} });

      api.registerProvider({
        id: "Qwen",
        label: "Qwen",
        auth: [],
      });

      const provider = registry.providers.find((p) => p.provider.id === "qwen-portal");
      expect(provider).toBeDefined();
      expect(provider?.provider.id).toBe("qwen-portal");
    });

    it("detects duplicate providers regardless of original casing", () => {
      const record = {
        id: "test-plugin",
        name: "Test Plugin",
        source: "/test/index.ts",
        origin: "bundled" as const,
        enabled: true,
        status: "loaded" as const,
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        speechProviderIds: [],
        mediaUnderstandingProviderIds: [],
        imageGenerationProviderIds: [],
        webSearchProviderIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpRoutes: 0,
        hookCount: 0,
        configSchema: false,
      };

      const api = createApi(record, { config: {} });

      api.registerProvider({
        id: "openai",
        label: "OpenAI",
        auth: [],
      });

      api.registerProvider({
        id: "OPENAI",
        label: "OpenAI Uppercase",
        auth: [],
      });

      expect(registry.providers).toHaveLength(1);
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("provider already registered"),
        }),
      );
    });

    it("normalizes bedrock variants to amazon-bedrock", () => {
      const record = {
        id: "test-plugin",
        name: "Test Plugin",
        source: "/test/index.ts",
        origin: "bundled" as const,
        enabled: true,
        status: "loaded" as const,
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        speechProviderIds: [],
        mediaUnderstandingProviderIds: [],
        imageGenerationProviderIds: [],
        webSearchProviderIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpRoutes: 0,
        hookCount: 0,
        configSchema: false,
      };

      const api = createApi(record, { config: {} });

      api.registerProvider({
        id: "AWS-Bedrock",
        label: "AWS Bedrock",
        auth: [],
      });

      const provider = registry.providers.find((p) => p.provider.id === "amazon-bedrock");
      expect(provider).toBeDefined();
      expect(provider?.provider.id).toBe("amazon-bedrock");
    });
  });
});
