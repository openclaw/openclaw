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
});
