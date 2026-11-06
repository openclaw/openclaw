import { expect, it } from "vitest";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import {
  beginModelCatalogRead,
  clearModelCatalogCache,
  publishModelCatalogResult,
} from "./model-catalog-cache.ts";
import { readCachedProviderPresentation } from "./provider-presentation-cache.ts";

it("derives presentation from the connected catalog and retires it with the catalog", () => {
  const first = createTestGatewayClient(createGatewayRequestMock());
  const second = createTestGatewayClient(createGatewayRequestMock());
  const provider = "workstation";
  const model = { id: "stable-id", name: "Local model", provider };
  for (const [client, providerName] of [
    [first, "First workstation"],
    [second, "Second workstation"],
  ] as const) {
    publishModelCatalogResult(
      beginModelCatalogRead(client, {}),
      {},
      { models: [model], providerPresentations: { [provider]: { providerName } } },
    );
  }
  expect(readCachedProviderPresentation(first, provider)?.providerName).toBe("First workstation");
  expect(readCachedProviderPresentation(second, provider)?.providerName).toBe("Second workstation");
  publishModelCatalogResult(
    beginModelCatalogRead(first, {}),
    { refresh: true },
    {
      models: [model],
      providerPresentations: { [provider]: { providerName: "Renamed workstation" } },
    },
  );
  expect(readCachedProviderPresentation(first, provider)?.providerName).toBe("Renamed workstation");
  clearModelCatalogCache(first);
  expect(readCachedProviderPresentation(first, provider)).toBeUndefined();
  expect(readCachedProviderPresentation(second, provider)?.providerName).toBe("Second workstation");
});
