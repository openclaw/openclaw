import { describe, expect, it, vi } from "vitest";
import {
  INVENTORY_ADJUST_QUANTITIES_MUTATION,
  buildInventoryAdjustInput,
  buildVariantSearchQuery,
  createShopifyService,
  type ShopifyPluginConfig,
} from "../.openclaw/extensions/shopify/shopify.ts";

const VARIANT_ID = "gid://shopify/ProductVariant/100";
const INVENTORY_ITEM_ID = "gid://shopify/InventoryItem/200";

function makeTokenConfig(): ShopifyPluginConfig {
  return {
    storeDomain: "example-store.myshopify.com",
    auth: {
      mode: "token",
      adminToken: "test-token",
    },
    locationId: "gid://shopify/Location/300",
    apiVersion: "2026-04",
    defaultDryRun: true,
  };
}

function makeOauthConfig(): ShopifyPluginConfig {
  return {
    storeDomain: "example-store.myshopify.com",
    auth: {
      mode: "oauth",
      clientId: "client-id",
      clientSecret: "client-secret",
    },
    locationId: "gid://shopify/Location/300",
    apiVersion: "2026-04",
    defaultDryRun: true,
  };
}

function asJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function buildVariantSnapshot(available: number, tracked = true) {
  return {
    data: {
      productVariant: {
        id: VARIANT_ID,
        title: "Black / Large",
        sku: "HD-BLK-L",
        barcode: "123456",
        product: { title: "Hoodie" },
        inventoryItem: {
          id: INVENTORY_ITEM_ID,
          tracked,
          inventoryLevel: {
            id: "gid://shopify/InventoryLevel/400",
            quantities: [{ name: "available", quantity: available }],
          },
        },
      },
    },
  };
}

function createFetchMock(entries: unknown[]) {
  const queue = [...entries];
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) {
      throw new Error("No mock response available for fetch call");
    }
    if (next instanceof Response) {
      return next;
    }
    return asJsonResponse(next);
  });
}

function getGraphqlRequestBody(fetchMock: ReturnType<typeof createFetchMock>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Missing fetch call at index ${index}`);
  }
  const init = call[1];
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error(`Expected string request body at call ${index}`);
  }
  return JSON.parse(body) as {
    query: string;
    variables?: {
      idempotencyKey?: string;
      input?: { changes?: Array<{ changeFromQuantity?: number }> };
    };
  };
}

function getGraphqlBodies(fetchMock: ReturnType<typeof createFetchMock>) {
  return fetchMock.mock.calls
    .map((call) => {
      const init = call[1];
      if (!init || typeof init.body !== "string") {
        return null;
      }
      const parsed = JSON.parse(init.body) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      if (typeof parsed.query !== "string") {
        return null;
      }
      return parsed;
    })
    .filter((value): value is { query: string; variables?: Record<string, unknown> } =>
      Boolean(value),
    );
}

function getRequestUrl(
  fetchMock: ReturnType<typeof createFetchMock>,
  index: number,
): string | undefined {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    return undefined;
  }
  const [input] = call;
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return undefined;
}

describe("Shopify workspace plugin helpers", () => {
  it("builds variant search query from sku/barcode/text", () => {
    expect(buildVariantSearchQuery({ sku: "HD-BLK-L" })).toBe("sku:HD-BLK-L");
    expect(buildVariantSearchQuery({ barcode: "123456" })).toBe("barcode:123456");
    expect(buildVariantSearchQuery({ text: "Hoodie black large" })).toBe("Hoodie black large");
    expect(buildVariantSearchQuery({ text: "   " })).toBeNull();
  });

  it("apply payload includes @idempotent directive and changeFromQuantity", () => {
    expect(INVENTORY_ADJUST_QUANTITIES_MUTATION).toContain("@idempotent(key: $idempotencyKey)");

    const payload = buildInventoryAdjustInput({
      inventoryItemId: INVENTORY_ITEM_ID,
      locationId: "gid://shopify/Location/300",
      delta: -2,
      before: 7,
      reason: "correction",
      referenceDocumentUri: "openclaw://shopify/sold",
    });

    expect(payload.name).toBe("available");
    expect(payload.changes[0]?.changeFromQuantity).toBe(7);
    expect(payload.changes[0]?.delta).toBe(-2);
  });

  it("preview is read-only and does not mutate inventory", async () => {
    const fetchMock = createFetchMock([buildVariantSnapshot(9)]);

    const service = createShopifyService({
      config: makeTokenConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      randomUuid: () => "preview-key",
    });

    const preview = await service.inventoryPreview({ variantId: VARIANT_ID, delta: -1 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      throw new Error("Expected preview to succeed");
    }

    const firstBody = getGraphqlRequestBody(fetchMock, 0);
    expect(firstBody.query).not.toContain("inventoryAdjustQuantities");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("apply requires idempotency key", async () => {
    const fetchMock = createFetchMock([]);

    const service = createShopifyService({
      config: makeTokenConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await service.inventoryApply({
      variantId: VARIANT_ID,
      delta: -1,
      expectedQuantity: 9,
      idempotencyKey: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected apply to fail");
    }
    expect(result.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("apply fails when expected quantity no longer matches", async () => {
    const fetchMock = createFetchMock([buildVariantSnapshot(8)]);

    const service = createShopifyService({
      config: makeTokenConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await service.inventoryApply({
      variantId: VARIANT_ID,
      delta: -1,
      expectedQuantity: 9,
      idempotencyKey: "idem-mismatch",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected apply to be blocked");
    }
    expect(result.code).toBe("EXPECTED_QUANTITY_MISMATCH");

    const bodies = getGraphqlBodies(fetchMock);
    const hasMutation = bodies.some((body) => body.query.includes("inventoryAdjustQuantities"));
    expect(hasMutation).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks apply when resulting inventory would be negative", async () => {
    const fetchMock = createFetchMock([buildVariantSnapshot(1)]);

    const service = createShopifyService({
      config: makeTokenConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await service.inventoryApply({
      variantId: VARIANT_ID,
      delta: -2,
      expectedQuantity: 1,
      idempotencyKey: "idem-negative",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected apply to be blocked");
    }
    expect(result.code).toBe("NEGATIVE_INVENTORY_BLOCKED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("idempotent retry is safe and does not double decrement", async () => {
    const fetchMock = createFetchMock([
      buildVariantSnapshot(9),
      {
        data: {
          inventoryAdjustQuantities: {
            userErrors: [],
            inventoryAdjustmentGroup: {
              changes: [{ name: "available", quantityAfterChange: 8 }],
            },
          },
        },
      },
      buildVariantSnapshot(8),
      buildVariantSnapshot(8),
    ]);

    const service = createShopifyService({
      config: makeTokenConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const first = await service.inventoryApply({
      variantId: VARIANT_ID,
      delta: -1,
      expectedQuantity: 9,
      idempotencyKey: "idem-123",
    });

    expect(first.ok).toBe(true);

    const second = await service.inventoryApply({
      variantId: VARIANT_ID,
      delta: -1,
      expectedQuantity: 9,
      idempotencyKey: "idem-123",
    });

    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error("Expected second apply to be blocked");
    }
    expect(second.code).toBe("EXPECTED_QUANTITY_MISMATCH");

    const bodies = getGraphqlBodies(fetchMock);
    const mutationBodies = bodies.filter((body) =>
      body.query.includes("inventoryAdjustQuantities(input: $input)"),
    );
    expect(mutationBodies).toHaveLength(1);
  });

  it("fetches OAuth access token and uses it for GraphQL", async () => {
    const fetchMock = createFetchMock([
      { access_token: "oauth-token-123", expires_in: 3600 },
      {
        data: {
          shop: {
            id: "gid://shopify/Shop/1",
            name: "Family Store",
            myshopifyDomain: "example-store.myshopify.com",
          },
        },
      },
    ]);

    const service = createShopifyService({
      config: makeOauthConfig(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await service.healthcheck();
    expect(result.ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = getRequestUrl(fetchMock, 0) ?? "";
    const secondUrl = getRequestUrl(fetchMock, 1) ?? "";

    expect(firstUrl).toContain("/admin/oauth/access_token");
    expect(secondUrl).toContain("/admin/api/2026-04/graphql.json");

    const firstInit = fetchMock.mock.calls[0]?.[1];
    const firstBodyRaw = firstInit?.body;
    expect(typeof firstBodyRaw).toBe("string");
    const firstBody = JSON.parse(firstBodyRaw as string) as {
      client_id?: string;
      client_secret?: string;
      grant_type?: string;
    };
    expect(firstBody.client_id).toBe("client-id");
    expect(firstBody.client_secret).toBe("client-secret");
    expect(firstBody.grant_type).toBe("client_credentials");

    const secondInit = fetchMock.mock.calls[1]?.[1];
    const headers = (secondInit?.headers ?? {}) as Record<string, string>;
    expect(headers["x-shopify-access-token"]).toBe("oauth-token-123");
  });
});
