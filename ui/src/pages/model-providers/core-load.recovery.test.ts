import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { readAgentModelCatalog } from "../../lib/model-catalog-store.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { ModelProviderCoreLoader } from "./core-load.ts";

it.each(["providers", "discovery"] as const)(
  "reconciles discovery completed during an active %s read",
  async (mode) => {
    const auth = createDeferred();
    const catalogRead = createDeferred();
    const initialCatalog = createDeferred<ModelCatalogResult>();
    const ready: ModelCatalogResult = {
      models: [{ id: "fixture", name: "Fixture", provider: "openai", available: true }],
    };
    let reads = 0;
    const request = createGatewayRequestMock(async (method) => {
      if (method === "models.authStatus") {
        await auth.promise;
        return { ts: 1, providers: [] };
      }
      if (method === "models.list") {
        catalogRead.resolve();
        return reads++ === 0 ? initialCatalog.promise : ready;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = createTestGatewayClient(request);
    const loader = new ModelProviderCoreLoader(() => {}, {
      onStart: () => {},
      onComplete: () => {},
      onCatalogComplete: () => {},
    });
    const loading =
      mode === "providers"
        ? loader.refresh(client, "main", "replacement")
        : loader.discoverCatalog(client, "main", () => true);
    await catalogRead.promise;
    // The notification arrives while the wire still holds its earlier pending snapshot.
    invalidateModelCatalogCache(client, { agentId: "main" });
    const published = loader.refresh(client, "main", "publication");
    initialCatalog.resolve({ ...ready, pendingProviders: ["openai"] });
    auth.resolve();
    await Promise.all([loading, published]);
    await vi.waitFor(() => {
      expect(
        readAgentModelCatalog(client, "main", { includeDetails: true }).pendingProviders ?? [],
      ).toEqual([]);
      expect(loader.loading).toBe(false);
    });
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(2);
  },
);

it("only publishes the current read after replacing an active read", async () => {
  const first = createDeferred();
  const next = createDeferred();
  let calls = 0;
  const request = createGatewayRequestMock(async (method) => {
    if (method === "models.authStatus") {
      await (calls++ === 0 ? first.promise : next.promise);
      return { ts: calls, providers: [] };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const completed = vi.fn();
  const loader = new ModelProviderCoreLoader(() => {}, {
    onStart: () => {},
    onComplete: completed,
    onCatalogComplete: () => {},
  });
  const client = createTestGatewayClient(request);
  const original = loader.refresh(client, "main", "replacement");
  await loader.refresh(client, "main", "publication");
  const replacement = loader.refresh(client, "main", "replacement");
  first.resolve();
  await original;
  expect(completed).not.toHaveBeenCalled();
  next.resolve();
  await replacement;
  expect(completed).toHaveBeenCalledOnce();
});
