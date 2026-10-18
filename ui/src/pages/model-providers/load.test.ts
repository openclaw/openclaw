import { describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { requestProviderUsage } from "../../lib/provider-usage-request.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { loadModelProviderCost, loadModelProvidersData } from "./load.ts";

const emptyAuth = { ts: 1, providers: [] };
function mockModelRequests(
  catalog: (params?: unknown) => unknown,
  auth: () => unknown = () => emptyAuth,
) {
  return vi.fn(async (method: string, params?: unknown) => {
    if (method === "models.authStatus") {
      return auth();
    }
    if (method === "models.list") {
      return catalog(params);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}
function cachedModels(client: GatewayBrowserClient, agentId = "main", allowStale = false) {
  return peekModelCatalog(client, { agentId }, { allowStale })?.models;
}

describe("loadModelProvidersData", () => {
  it("reads the refreshed catalog after failed auth publication", async () => {
    const auth = createDeferred();
    let authPending = true;
    const client = createTestGatewayClient(async (method) => {
      if (method === "models.authStatus") {
        try {
          await auth.promise;
        } finally {
          authPending = false;
        }
        return emptyAuth;
      }
      if (method === "models.list") {
        if (authPending) {
          throw new Error("Model catalog changed while preparing this result. Retry the request.");
        }
        return { models: [{ id: "published", name: "Published", provider: "ollama" }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const loading = loadModelProvidersData(client, { agentId: "writer", refresh: true });
    auth.reject(new Error("Authentication status unavailable"));
    const result = await loading;

    expect(cachedModels(client, "writer")).toEqual([
      { id: "published", name: "Published", provider: "ollama" },
    ]);
    expect(result.catalogError).toBeNull();
    expect(result.error).toBe("Authentication status unavailable");
  });

  it("does not acquire models when the page retires during auth publication", async () => {
    const auth = createDeferred();
    const modelRequests: unknown[] = [];
    const client = createTestGatewayClient(async (method, params) => {
      if (method === "models.authStatus") {
        await auth.promise;
        return emptyAuth;
      }
      if (method === "models.list") {
        modelRequests.push(params);
        return { models: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const controller = new AbortController();

    const loading = loadModelProvidersData(client, {
      agentId: "writer",
      refresh: true,
      signal: controller.signal,
    });
    controller.abort();
    auth.resolve();
    await loading;

    expect(modelRequests).toEqual([]);
  });

  it("keeps failed provider outcomes from a fulfilled explicit refresh", async () => {
    const client = createTestGatewayClient(async (method) => {
      if (method === "models.list") {
        return {
          models: [{ provider: "ollama", id: "retained", name: "Retained model", available: true }],
          refreshFailed: true,
          providerOutcomes: [{ provider: "ollama", status: "unavailable" }],
        };
      }
      return method === "models.authStatus" ? { ts: 1, providers: [] } : {};
    });
    const result = await loadModelProvidersData(client, { agentId: "main", refresh: true });

    expect(result.providerOutcomes).toEqual([{ provider: "ollama", status: "unavailable" }]);
    expect(cachedModels(client, "main", true)).toEqual([
      { provider: "ollama", id: "retained", name: "Retained model", available: true },
    ]);
    expect(result.catalogError).toBe("More models could not be discovered.");
    expect(peekModelCatalog(client, { agentId: "main" })).toBeUndefined();
    expect(result.error).toBeNull();
  });

  it("surfaces an initial catalog failure without discarding provider data", async () => {
    const request = mockModelRequests(
      () => {
        throw new Error("configured catalog unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
      },
      () => ({
        ts: 1,
        providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
      }),
    );
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main" });

    expect(peekModelCatalog(client, { agentId: "main" })).toBeUndefined();
    expect(result.catalogError).toBe(
      "configured catalog unavailable: OPENAI_API_KEY=sk-123...cdef",
    );
    expect(result.authStatus?.providers).toHaveLength(1);
    expect(result.error).toBeNull();
  });

  it("surfaces unavailable auth preparation without discarding configured models", async () => {
    const unavailable = {
      code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
      message: "Model authentication status is unavailable. Refresh Models after setup finishes.",
    };
    const request = mockModelRequests(
      () => ({ models: [{ id: "configured", name: "Configured", provider: "test-provider" }] }),
      () => ({ ts: 1, providers: [], unavailable }),
    );

    const client = createTestGatewayClient(request);
    const result = await loadModelProvidersData(client, {
      agentId: "main",
    });

    expect(result.error).toBe(unavailable.message);
    expect(result.authStatus).toMatchObject({ unavailable });
    expect(cachedModels(client)).toEqual([
      { id: "configured", name: "Configured", provider: "test-provider" },
    ]);
  });

  it("retries a missing auth-status response without discarding other provider data", async () => {
    let malformed = true;
    const request = mockModelRequests(
      () => ({ models: [] }),
      () => (malformed ? undefined : { ts: 2, providers: [] }),
    );
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main" });

    expect(cachedModels(client)).toEqual([]);
    expect(result.authStatus).toEqual({ ts: 0, providers: [] });
    expect(result).toMatchObject({
      providerOutcomes: [],
      catalogError: null,
      providerUsage: null,
      costByProvider: null,
      error: null,
    });
    malformed = false;
    expect((await loadModelProvidersData(client, { agentId: "main" })).authStatus).toEqual({
      ts: 2,
      providers: [],
    });
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(2);
  });

  it("retires both supplemental requests when aborted while pending", async () => {
    const pending = new GatewayPendingRequests({
      createRequestId: () => "models-test",
      nowMs: () => 0,
    });
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const sender = {
      send(frame: string) {
        sent.push(JSON.parse(frame));
      },
    };
    const client = {
      request: <T>(...args: Parameters<GatewayBrowserClient["request"]>) =>
        pending.request<T>(sender, ...args),
    } as GatewayBrowserClient;
    const controller = new AbortController();
    const loading = Promise.allSettled([
      requestProviderUsage(client, { signal: controller.signal }),
      loadModelProviderCost(client, controller.signal),
    ]);
    try {
      expect(sent.map(({ method }) => method)).toEqual(["usage.status", "sessions.usage"]);
      expect(sent[0]?.params).toBeUndefined();
      expect(sent[1]?.params).toMatchObject({
        agentScope: "all",
        groupBy: "family",
        projection: "overview",
        limit: 50,
      });
      expect(sent[1]?.params).not.toHaveProperty("agentId");
      expect(pending.hasPending).toBe(true);
      controller.abort();
      expect(pending.hasPending).toBe(false);
      expect(await loading).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
    } finally {
      // Release any leaked wait if a cancellation regression makes the assertion fail.
      pending.flush(new Error("test cleanup"));
      await loading;
    }
  });

  it("surfaces an explicit catalog refresh failure while retaining published configured models", async () => {
    const request = mockModelRequests(
      (params) => {
        if ((params as { refresh?: boolean } | undefined)?.refresh === true) {
          throw new Error("catalog refresh failed: OPENAI_API_KEY=sk-1234567890abcdef");
        }
        return { models: [{ id: "cached", name: "Cached", provider: "openai" }] };
      },
      () => ({ ...emptyAuth, providerCapabilities: [] }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    await loadModelProvidersData(client, { agentId: "writer" });
    request.mockClear();

    const result = await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(result.catalogError).toBe("catalog refresh failed: OPENAI_API_KEY=sk-123...cdef");
    expect(cachedModels(client, "writer")).toEqual([
      { id: "cached", name: "Cached", provider: "openai" },
    ]);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
      ["models.list", { view: "configured", agentId: "writer", refresh: true }],
      ["models.list", { view: "configured", agentId: "writer" }],
    ]);
  });
});
