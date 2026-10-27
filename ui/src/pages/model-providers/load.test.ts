import { expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { requestProviderUsage } from "../../lib/provider-usage-request.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { loadModelProvidersData } from "./load.ts";

const emptyAuth = { ts: 1, providers: [] };
const model = { id: "configured", name: "Configured", provider: "test-provider" };
const configured = { models: [model] };
function harness(
  catalog: (params?: unknown) => unknown = () => configured,
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
    load: (refresh = false, signal?: AbortSignal) =>
      loadModelProvidersData(client, { agentId: "main", refresh, signal }),
    cached: (allowStale = false) =>
      peekModelCatalog(client, { agentId: "main", includeDetails: true }, { allowStale }),
  };
}

it.each(["auth failure", "page retirement"])(
  "settles %s before acquiring models",
  async (ending) => {
    const auth = createDeferred();
    const events: string[] = [];
    const catalog = vi.fn(() => {
      events.push("catalog");
      return configured;
    });
    const h = harness(catalog, async () => {
      try {
        await auth.promise;
      } finally {
        events.push("auth");
      }
      return emptyAuth;
    });
    const controller = new AbortController();
    const loading = h.load(true, controller.signal);
    if (ending === "page retirement") {
      controller.abort();
      auth.resolve();
    } else {
      auth.reject(new Error("Authentication status unavailable"));
    }
    const result = await loading;
    if (ending === "page retirement") {
      expect(catalog).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        catalogError: null,
        error: "Authentication status unavailable",
      });
      expect(h.cached()?.models).toEqual([model]);
      expect(events).toEqual(["auth", "catalog"]);
    }
  },
);

it("keeps failed provider outcomes from a fulfilled explicit refresh", async () => {
  const retained = { ...model, provider: "ollama", available: true };
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
  expect(h.cached(true)?.models).toEqual([retained]);
  expect(h.cached()).toBeUndefined();
});

it.each([false, true])(
  "retains providers and redacts catalog failures (refresh=%s)",
  async (refresh) => {
    const h = harness(
      (params) => {
        if (!refresh || (params as { refresh?: boolean } | undefined)?.refresh) {
          throw new Error("catalog unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
        }
        return configured;
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
      catalogError: "catalog unavailable: OPENAI_API_KEY=sk-123...cdef",
      error: null,
    });
    expect(result.authStatus?.providers).toHaveLength(1);
    if (refresh) {
      expect(h.cached()?.models).toEqual([model]);
      expect(h.request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
        [
          "models.list",
          { view: "configured", includeDetails: true, agentId: "main", refresh: true },
        ],
        ["models.list", { view: "configured", includeDetails: true, agentId: "main" }],
      ]);
    } else {
      expect(h.cached()).toBeUndefined();
    }
  },
);

it("surfaces unavailable auth preparation without discarding configured models", async () => {
  const unavailable = { code: "PREPARED_MODEL_AUTH_UNAVAILABLE", message: "Unavailable." };
  const h = harness(undefined, () => ({ ...emptyAuth, unavailable }));
  expect(await h.load()).toMatchObject({ error: unavailable.message, authStatus: { unavailable } });
  expect(h.cached()?.models).toEqual([model]);
});

it("retries a missing auth-status response without discarding other provider data", async () => {
  let malformed = true;
  const h = harness(
    () => ({ models: [] }),
    () => (malformed ? undefined : { ts: 2, providers: [] }),
    true,
  );
  const result = await h.load();
  expect(result.authStatus).toEqual({ ts: 0, providers: [] });
  expect(result).toMatchObject({
    providerOutcomes: [],
    catalogError: null,
    providerUsage: null,
    providerUsageFailed: false,
    error: null,
  });
  expect(h.cached()?.models).toEqual([]);
  malformed = false;
  expect((await h.load()).authStatus).toEqual({ ts: 2, providers: [] });
  expect(h.request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(2);
});

it("retires the provider usage request when aborted while pending", async () => {
  const pending = new GatewayPendingRequests({
    createRequestId: () => "models",
    nowMs: () => 0,
  });
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const send = (frame: string) => sent.push(JSON.parse(frame));
  const client = {
    request: <T>(...args: Parameters<GatewayBrowserClient["request"]>) =>
      pending.request<T>({ send }, ...args),
  } as GatewayBrowserClient;
  const controller = new AbortController();
  const loading = Promise.allSettled([requestProviderUsage(client, { signal: controller.signal })]);
  try {
    // Local session usage belongs to the Usage page; Models reads only provider usage.
    expect(sent.map(({ method }) => method)).toEqual(["usage.status"]);
    expect(sent[0]?.params).toBeUndefined();
    expect(pending.hasPending).toBe(true);
    controller.abort();
    expect(pending.hasPending).toBe(false);
    expect(await loading).toMatchObject([{ status: "rejected" }]);
  } finally {
    // Release a leaked wait even if cancellation regresses.
    pending.flush(new Error("test cleanup"));
    await loading;
  }
});
