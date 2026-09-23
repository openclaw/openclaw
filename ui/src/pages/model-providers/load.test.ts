import { describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { loadModelProviderCost, loadModelProvidersData, loadModelProviderUsage } from "./load.ts";

describe("loadModelProvidersData", () => {
  it.each([false, true])(
    "publishes current partial inventory for display while reporting failure (returned rows: %s)",
    async (hasRows) => {
      const models = hasRows ? [{ provider: "fixture", id: "retained", name: "Retained" }] : [];
      const client = createTestGatewayClient(async (method) => {
        if (method === "models.list") {
          return { models, refreshFailed: true };
        }
        return method === "models.authStatus" ? { ts: 1, providers: [] } : {};
      });
      const result = await loadModelProvidersData(client, { agentId: "main" });
      expect(peekModelCatalog(client, { agentId: "main" })).toBeUndefined();
      expect(peekModelCatalog(client, { agentId: "main" }, { allowStale: true })?.models).toEqual(
        models,
      );
      expect(result.catalogError).toBe("More models could not be discovered.");
      expect(result.error).toBeNull();
    },
  );

  it.each([false, true])(
    "reads the refreshed catalog after auth publication, including auth failure %s",
    async (authFails) => {
      const auth = createDeferred();
      let authPending = true;
      const client = createTestGatewayClient(async (method) => {
        if (method === "models.authStatus") {
          try {
            await auth.promise;
          } finally {
            authPending = false;
          }
          return { ts: 1, providers: [] };
        }
        if (method === "models.list") {
          if (authPending) {
            throw new Error(
              "Model catalog changed while preparing this result. Retry the request.",
            );
          }
          return { models: [{ id: "published", name: "Published", provider: "ollama" }] };
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      const loading = loadModelProvidersData(client, { agentId: "writer", refresh: true });
      if (authFails) {
        auth.reject(new Error("Authentication status unavailable"));
      } else {
        auth.resolve();
      }
      const result = await loading;

      expect(peekModelCatalog(client, { agentId: "writer" })?.models).toEqual([
        { id: "published", name: "Published", provider: "ollama" },
      ]);
      expect(result.catalogError).toBeNull();
      expect(result.error).toBe(authFails ? "Authentication status unavailable" : null);
    },
  );

  it("does not acquire models when the page retires during auth publication", async () => {
    const auth = createDeferred();
    const modelRequests: unknown[] = [];
    const client = createTestGatewayClient(async (method, params) => {
      if (method === "models.authStatus") {
        await auth.promise;
        return { ts: 1, providers: [] };
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
    expect(peekModelCatalog(client, { agentId: "main" }, { allowStale: true })?.models).toEqual([
      { provider: "ollama", id: "retained", name: "Retained model", available: true },
    ]);
    expect(result.catalogError).toBe("More models could not be discovered.");
    expect(peekModelCatalog(client, { agentId: "main" })).toBeUndefined();
    expect(result.error).toBeNull();
  });

  it("keeps full catalog discovery out of the initial page load", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "models.list":
          return { models: [] };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "writer",
    });
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" && (params as { view?: string } | undefined)?.view === "all",
      ),
    ).toHaveLength(0);
    expect(request.mock.calls.some(([method]) => method === "usage.status")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "sessions.usage")).toBe(false);
    expect(result.providerUsage).toBeNull();
    expect(result.costByProvider).toBeNull();
  });

  it("scopes only credential status to the selected agent", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.authStatus", {
      refresh: true,
      agentId: "writer",
    });
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
      ["models.list", { view: "configured", agentId: "writer", refresh: true }],
    ]);
    expect(result.providerOutcomes).toEqual([]);
    expect(request.mock.calls.some(([method]) => method === "usage.status")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "sessions.usage")).toBe(false);
  });

  it("does not send a configured refresh for an already-retired page task", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new AbortController();
    controller.abort(new DOMException("page retired", "AbortError"));

    await loadModelProvidersData(client, {
      agentId: "writer",
      refresh: true,
      signal: controller.signal,
    });

    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([]);
  });

  it.each([
    { label: "the initial published catalog", refresh: false },
    { label: "the configured catalog after discovery", refresh: true },
  ])("surfaces a failure loading $label without discarding provider data", async ({ refresh }) => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return {
            ts: 1,
            providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
          };
        case "models.list":
          throw new Error("configured catalog unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main", refresh });

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
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], unavailable };
        case "models.list":
          return { models: [{ id: "configured", name: "Configured", provider: "test-provider" }] };
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    });

    const client = createTestGatewayClient(request);
    const result = await loadModelProvidersData(client, {
      agentId: "main",
    });

    expect(result.error).toBe(unavailable.message);
    expect(result.authStatus).toMatchObject({ unavailable });
    expect(peekModelCatalog(client, { agentId: "main" })?.models).toEqual([
      { id: "configured", name: "Configured", provider: "test-provider" },
    ]);
  });

  it.each([{}, null, undefined, "invalid", 42, { providers: null }, { providers: {} }])(
    "degrades invalid auth-status response %j without discarding other provider data",
    async (invalid) => {
      let malformed = true;
      const request = vi.fn(async (method: string) => {
        switch (method) {
          case "models.authStatus":
            return malformed ? invalid : { ts: 2, providers: [] };
          case "models.list":
            return { models: [] };
          case "usage.status":
            return { updatedAt: 1, providers: [] };
          case "sessions.usage":
            return { aggregates: { byProvider: [] } };
          default:
            return {};
        }
      });
      const client = { request } as unknown as GatewayBrowserClient;

      const result = await loadModelProvidersData(client, { agentId: "main" });

      expect(result.authStatus).toEqual(invalid == null ? { ts: 0, providers: [] } : null);
      expect(peekModelCatalog(client, { agentId: "main" })?.models).toEqual([]);
      expect(result.providerOutcomes).toEqual([]);
      expect(result.catalogError).toBeNull();
      expect(result.providerUsage).toBeNull();
      expect(result.costByProvider).toBeNull();
      expect(result.error).toBeNull();
      malformed = false;
      expect((await loadModelProvidersData(client, { agentId: "main" })).authStatus).toEqual({
        ts: 2,
        providers: [],
      });
      expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(
        2,
      );
    },
  );

  it("records a usage.status failure instead of reducing it to no data", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "usage.status":
          throw new Error("usage.status failed");
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProviderUsage(client, new AbortController().signal);

    expect(result).toEqual({
      ok: false,
      error: { kind: "request-failed" },
    });
  });

  it("keeps provider-scoped usage errors as data instead of a global request failure", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "usage.status":
          return {
            updatedAt: 1,
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                windows: [],
                error: "provider API unavailable",
              },
            ],
          };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProviderUsage(client, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: { providers: [{ error: "provider API unavailable" }] },
    });
  });

  it.each(["before dispatch", "while pending"] as const)(
    "retires both supplemental requests when aborted %s",
    async (when) => {
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
      if (when === "before dispatch") {
        controller.abort();
      }
      const loading = Promise.allSettled([
        loadModelProviderUsage(client, controller.signal),
        loadModelProviderCost(client, controller.signal),
      ]);
      try {
        if (when === "while pending") {
          expect(sent.map(({ method }) => method)).toEqual(["usage.status", "sessions.usage"]);
          expect(sent[0]?.params).toBeUndefined();
          expect(sent[1]?.params).toMatchObject({ agentScope: "all", groupBy: "family" });
          expect(sent[1]?.params).not.toHaveProperty("agentId");
          expect(pending.hasPending).toBe(true);
          controller.abort();
        } else {
          expect(sent).toEqual([]);
        }
        expect(pending.hasPending).toBe(false);
        expect(await loading).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
      } finally {
        // Release any leaked wait if a cancellation regression makes the assertion fail.
        pending.flush(new Error("test cleanup"));
        await loading;
      }
    },
  );

  it("surfaces an explicit catalog refresh failure while retaining published configured models", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "models.list":
          if ((params as { refresh?: boolean } | undefined)?.refresh === true) {
            throw new Error("catalog refresh failed: OPENAI_API_KEY=sk-1234567890abcdef");
          }
          return {
            models: [{ id: "cached", name: "Cached", provider: "openai" }],
          };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    await loadModelProvidersData(client, { agentId: "writer" });
    request.mockClear();

    const result = await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(result.catalogError).toBe("catalog refresh failed: OPENAI_API_KEY=sk-123...cdef");
    expect(peekModelCatalog(client, { agentId: "writer" })?.models).toEqual([
      { id: "cached", name: "Cached", provider: "openai" },
    ]);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
      ["models.list", { view: "configured", agentId: "writer", refresh: true }],
      ["models.list", { view: "configured", agentId: "writer" }],
    ]);
  });
});
