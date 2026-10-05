import { describe, expect, test, vi } from "vitest";
import type {
  GatewayModelCatalogLoadParams,
  GatewayModelCatalogSnapshot,
} from "./server-model-catalog.types.js";
import { resolveGatewayModelSupportsImages } from "./session-utils-model.js";

describe("resolveGatewayModelSupportsImages", () => {
  type Model = GatewayModelCatalogSnapshot["entries"][number];
  const vision: Model = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    input: ["text", "image"],
  };
  const query = { agentId: "qa", model: vision.id, provider: vision.provider };
  const snapshot = (
    overrides: Partial<GatewayModelCatalogSnapshot> = {},
  ): GatewayModelCatalogSnapshot => ({
    agentId: "qa",
    agentDir: "/tmp/gateway-model-capability-agent",
    workspaceDir: "/tmp/gateway-model-capability-workspace",
    catalogComplete: false,
    config: {},
    entries: [],
    routeVariants: [],
    ...overrides,
  });
  const preparedSupport = (
    prepared: GatewayModelCatalogSnapshot,
    provider: string | undefined = "openai",
  ) =>
    resolveGatewayModelSupportsImages({
      ...query,
      provider,
      loadGatewayModelCatalog: async () => [],
      loadGatewayModelCatalogSnapshot: async () => prepared,
    });

  test("uses prepared Sol capabilities without starting full catalog discovery", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => []);
    const loadGatewayModelCatalogSnapshot = vi.fn(
      async (params?: GatewayModelCatalogLoadParams) => {
        if (params?.readOnly !== true) {
          throw new Error("full catalog discovery must not start during attachment admission");
        }
        return snapshot({ staticEntries: [{ ...vision, id: "gpt-5.6-sol" }] });
      },
    );
    await expect(
      resolveGatewayModelSupportsImages({
        ...query,
        model: "gpt-5.6-sol",
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "qa", readOnly: true });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "discovers live capabilities when provisional metadata is text-only=%s",
    async (textOnly) => {
      const model: Model = {
        id: "vendor/runtime-vision-model",
        name: "Runtime Vision Model",
        provider: "openrouter",
        input: ["text", "image"],
      };
      const loadGatewayModelCatalogSnapshot = vi.fn(
        async (params?: GatewayModelCatalogLoadParams) =>
          snapshot({
            entries: params?.providerDiscoveryProviderIds
              ? [model]
              : textOnly
                ? [{ ...model, input: ["text"] }]
                : [],
          }),
      );
      await expect(
        resolveGatewayModelSupportsImages({
          ...query,
          model: model.id,
          provider: model.provider,
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot,
        }),
      ).resolves.toBe(true);
      expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(1, {
        agentId: "qa",
        readOnly: true,
      });
      expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(2, {
        agentId: "qa",
        providerDiscoveryProviderIds: ["openrouter"],
        readOnly: true,
        scopedLiveProviderDiscovery: true,
      });
    },
  );

  test.each([false, true])(
    "does not rediscover a complete catalog with a text-only row=%s",
    async (hasRow) => {
      const modes: Array<boolean | undefined> = [];
      await expect(
        resolveGatewayModelSupportsImages({
          agentId: "qa",
          model: "vendor/runtime-text-model",
          provider: "openrouter",
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot: async (params) => {
            modes.push(params?.readOnly);
            if (params?.readOnly !== true) {
              throw new Error("full catalog discovery must not restart for a complete owner");
            }
            return snapshot({
              catalogComplete: true,
              entries: hasRow
                ? [
                    {
                      id: "vendor/runtime-text-model",
                      name: "Text",
                      provider: "openrouter",
                      input: ["text"],
                    },
                  ]
                : [],
            });
          },
        }),
      ).resolves.toBe(false);
      expect(modes).toEqual([true]);
    },
  );

  test("repairs stale visible text-only metadata with same-agent static vision", async () => {
    await expect(
      preparedSupport(
        snapshot({ entries: [{ ...vision, input: ["text"] }], staticEntries: [vision] }),
      ),
    ).resolves.toBe(true);
  });

  test("does not borrow another agent's static image capabilities", async () => {
    await expect(
      preparedSupport(snapshot({ agentId: "other", staticEntries: [vision] })),
    ).resolves.toBe(false);
  });

  test("does not override explicitly configured text-only input with static vision", async () => {
    const modes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        ...query,
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          modes.push(params?.readOnly);
          return snapshot({
            config: {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://api.openai.com/v1",
                    models: [
                      {
                        id: vision.id,
                        name: "Text only",
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 128_000,
                        maxTokens: 4_096,
                      },
                    ],
                  },
                },
              },
            },
            entries: [{ ...vision, baseUrl: "https://api.openai.com/v1", input: ["text"] }],
            staticEntries: [{ ...vision, baseUrl: "https://api.openai.com/v1" }],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(modes).toEqual([true]);
  });

  test("does not borrow static image capabilities across configured routes", async () => {
    await expect(
      preparedSupport(
        snapshot({
          config: {
            models: {
              providers: { openai: { baseUrl: "https://custom.example.test/v1", models: [] } },
            },
          },
          staticEntries: [{ ...vision, baseUrl: "https://api.openai.com/v1" }],
        }),
      ),
    ).resolves.toBe(false);
  });

  test.each([
    { route: "API", api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
    { route: "base URL", api: "openai-responses", baseUrl: "https://custom.example.test/v1" },
  ] as const)(
    "does not borrow static vision across a mismatched visible $route",
    async ({ api, baseUrl }) => {
      await expect(
        preparedSupport(
          snapshot({
            entries: [{ ...vision, api, baseUrl, input: ["text"] }],
            staticEntries: [
              { ...vision, api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
            ],
          }),
        ),
      ).resolves.toBe(false);
    },
  );

  test("fails closed on providerless static image capabilities", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "shared-vision",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          snapshot({
            staticEntries: [
              { ...vision, id: "shared-vision", provider: "first" },
              { ...vision, id: "shared-vision", provider: "second" },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("fails closed without a stale catalog when the prepared snapshot fails", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [vision]);
    await expect(
      resolveGatewayModelSupportsImages({
        ...query,
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: async () => {
          throw new Error("prepared catalog unavailable");
        },
      }),
    ).resolves.toBe(false);
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test.each([
    {
      model: "deployment-gpt5",
      provider: "microsoft-foundry",
      entry: {
        id: "deployment-gpt5",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        input: ["text"],
      },
    },
    {
      model: "claude-sonnet-4-6",
      provider: "claude-cli",
      entry: {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "claude-cli",
        input: ["text"],
      },
    },
    {
      model: "Qwen/Qwen3.5-35B-A3B",
      provider: undefined,
      entry: {
        id: "qwen/qwen3.5-35b-a3b",
        name: "Qwen3.5 35B",
        provider: "modelscope",
        input: ["text", "image"],
      },
    },
  ] satisfies Array<{ model: string; provider?: string; entry: Model }>)(
    "resolves legacy or providerless vision for $model",
    async ({ model, provider, entry }) => {
      await expect(
        resolveGatewayModelSupportsImages({
          model,
          provider,
          loadGatewayModelCatalog: async () => [entry],
        }),
      ).resolves.toBe(true);
    },
  );
});
