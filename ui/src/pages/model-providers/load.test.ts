import { describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { requestProviderUsage } from "../../lib/provider-usage-request.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { loadModelProviderCost, loadModelProvidersData } from "./load.ts";

const emptyAuth = { ts: 1, providers: [] };
const model = { id: "configured", name: "Configured", provider: "test-provider" };
const expectedModels = [{ ...model }];
function harness(
  catalog: (params?: unknown) => unknown,
  auth: () => unknown = () => emptyAuth,
  raw = false,
) {
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "models.authStatus") {
      return auth();
    }
    if (method === "models.list") {
      return catalog(params);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = raw
    ? ({ request } as unknown as GatewayBrowserClient)
    : createTestGatewayClient(request);
  return {
    request,
    client,
    load: (refresh = false, signal?: AbortSignal) =>
      loadModelProvidersData(client, { agentId: "main", refresh, signal }),
    cached: (allowStale = false) => peekModelCatalog(client, { agentId: "main" }, { allowStale }),
  };
}

describe("loadModelProvidersData", () => {
  it("reads the refreshed catalog after failed auth publication", async () => {
    const auth = createDeferred();
    let pending = true;
    const h = harness(
      () => {
        if (pending) {
          throw new Error("Model catalog changed while preparing this result. Retry the request.");
        }
        return { models: [model] };
      },
      async () => {
        try {
          await auth.promise;
        } finally {
          pending = false;
        }
        return emptyAuth;
      },
    );
    const loading = h.load(true);
    auth.reject(new Error("Authentication status unavailable"));
    expect(await loading).toMatchObject({
      catalogError: null,
      error: "Authentication status unavailable",
    });
    expect(h.cached()?.models).toEqual(expectedModels);
  });

  it("does not acquire models when the page retires during auth publication", async () => {
    const auth = createDeferred();
    const catalog = vi.fn(() => ({ models: [] }));
    const h = harness(catalog, async () => {
      await auth.promise;
      return emptyAuth;
    });
    const controller = new AbortController();
    const loading = h.load(true, controller.signal);
    controller.abort();
    auth.resolve();
    await loading;
    expect(catalog).not.toHaveBeenCalled();
  });

  it("keeps failed provider outcomes from a fulfilled explicit refresh", async () => {
    const retained = {
      provider: "ollama",
      id: "retained",
      name: "Retained model",
      available: true,
    };
    const h = harness(() => ({
      models: [retained],
      refreshFailed: true,
      providerOutcomes: [{ provider: "ollama", status: "unavailable" }],
    }));
    expect(await h.load(true)).toMatchObject({
      providerOutcomes: [{ provider: "ollama", status: "unavailable" }],
      catalogError: "More models could not be discovered.",
      error: null,
    });
    expect(h.cached(true)?.models).toEqual([
      { provider: "ollama", id: "retained", name: "Retained model", available: true },
    ]);
    expect(h.cached()).toBeUndefined();
  });

  it.each([false, true])(
    "retains provider data when catalog refresh=%s fails and redacts its error",
    async (refresh) => {
      const prefix = refresh ? "catalog refresh failed" : "configured catalog unavailable";
      const h = harness(
        (params) => {
          if (!refresh || (params as { refresh?: boolean } | undefined)?.refresh) {
            throw new Error(`${prefix}: OPENAI_API_KEY=sk-1234567890abcdef`);
          }
          return { models: [model] };
        },
        () => ({
          ...emptyAuth,
          providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
          ...(refresh ? { providerCapabilities: [] } : {}),
        }),
        true,
      );
      if (refresh) {
        await h.load();
        h.request.mockClear();
      }
      const result = await h.load(refresh);
      expect(result).toMatchObject({
        catalogError: `${prefix}: OPENAI_API_KEY=sk-123...cdef`,
        error: null,
      });
      expect(result.authStatus?.providers).toHaveLength(1);
      if (refresh) {
        expect(h.cached()?.models).toEqual(expectedModels);
        expect(h.request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
          ["models.list", { view: "configured", agentId: "main", refresh: true }],
          ["models.list", { view: "configured", agentId: "main" }],
        ]);
      } else {
        expect(h.cached()).toBeUndefined();
      }
    },
  );

  it("surfaces unavailable auth preparation without discarding configured models", async () => {
    const unavailable = {
      code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
      message: "Model authentication status is unavailable. Refresh Models after setup finishes.",
    };
    const h = harness(
      () => ({ models: [model] }),
      () => ({ ...emptyAuth, unavailable }),
    );
    expect(await h.load()).toMatchObject({
      error: unavailable.message,
      authStatus: { unavailable },
    });
    expect(h.cached()?.models).toEqual(expectedModels);
  });

  it("retries a missing auth-status response without discarding other provider data", async () => {
    let malformed = true;
    const h = harness(
      () => ({ models: [] }),
      () => (malformed ? undefined : { ts: 2, providers: [] }),
      true,
    );
    const result = await h.load();
    expect(h.cached()?.models).toEqual([]);
    expect(result.authStatus).toEqual({ ts: 0, providers: [] });
    expect(result).toMatchObject({
      providerOutcomes: [],
      catalogError: null,
      providerUsage: null,
      costByProvider: null,
      error: null,
    });
    malformed = false;
    expect((await h.load()).authStatus).toEqual({ ts: 2, providers: [] });
    expect(h.request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(
      2,
    );
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
      // Release a leaked wait even if cancellation regresses.
      pending.flush(new Error("test cleanup"));
      await loading;
    }
  });
});
