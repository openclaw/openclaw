import { describe, expect, it, vi } from "vitest";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import {
  clearModelCatalogCache,
  beginModelCatalogRead,
  publishModelCatalogResult,
  invalidateModelCatalogCache,
  isModelCatalogRetired,
  modelCatalogCache,
} from "./model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  settleModelCatalogRequests,
} from "./model-catalog-store.ts";

const prepared = { id: "prepared", name: "Prepared", provider: "example" };
const published = { id: "published", name: "Published", provider: "example" };

describe("model catalog display cache", () => {
  it.each(["snapshot", "invalidation"] as const)(
    "retains transport settlement after %s retires pending display readers",
    async (retirement) => {
      const wire = createDeferred<ModelCatalogResult>();
      const request = createGatewayRequestMock().mockReturnValueOnce(wire.promise);
      const client = createTestGatewayClient(request);
      const scope = { agentId: "main", sessionKey: "agent:main:retained" };
      const donation = beginModelCatalogRead(client, scope);
      const original = loadModelCatalog(client, scope);
      const onSettled = vi.fn();
      let settlement: Promise<void> | undefined;
      try {
        if (retirement === "snapshot") {
          publishModelCatalogResult(donation, scope, { models: [published] });
          expect(await original).toEqual({ models: [published] });
        } else {
          invalidateModelCatalogCache(client, scope);
        }
        settlement = settleModelCatalogRequests(client, scope)?.then(onSettled);
        expect(settlement).toBeDefined();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(onSettled).not.toHaveBeenCalled();
        wire.resolve({ models: [prepared] });
        await settlement;
        expect(onSettled).toHaveBeenCalledOnce();
      } finally {
        wire.resolve({ models: [prepared] });
        await Promise.all([original, settlement]);
      }
    },
  );
  it("rereads readiness when the earliest Gateway cooldown expires without a publication", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const cooling = {
      ...prepared,
      available: false,
      unavailableReason: "cooldown" as const,
      unavailableUntil: 12_000,
    };
    const recovered = { ...prepared, available: true };
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({
        models: [{ ...cooling, id: "later", unavailableUntil: 20_000 }, cooling],
      })
      .mockResolvedValueOnce({ models: [recovered] });
    const client = createTestGatewayClient(request);
    try {
      await loadModelCatalog(client, { agentId: "writer" });
      clock.mockReturnValue(11_999);
      expect(peekModelCatalog(client, { agentId: "writer" })?.models).toContainEqual(cooling);
      await loadModelCatalog(client, { agentId: "writer" });
      expect(request).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(12_000);
      expect(peekModelCatalog(client, { agentId: "writer" })).toBeUndefined();
      expect((await loadModelCatalog(client, { agentId: "writer" })).models).toEqual([recovered]);
      expect(request).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(100_000);
      expect(peekModelCatalog(client, { agentId: "writer" })?.models).toEqual([recovered]);
    } finally {
      clock.mockRestore();
    }
  });

  it("reuses a published snapshot synchronously until its Gateway generation changes", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({ models: [prepared] })
      .mockResolvedValueOnce({ models: [published] });
    const client = createTestGatewayClient(request);
    const scope = { agentId: "writer" };
    clearModelCatalogCache(client);
    expect(isModelCatalogRetired(client, scope)).toBe(false);
    expect(peekModelCatalog(client, scope)).toBeUndefined();
    expect((await loadModelCatalog(client, scope)).models).toEqual([prepared]);
    expect(peekModelCatalog(client, scope)?.models).toEqual([prepared]);
    expect((await loadModelCatalog(client, scope)).models).toEqual([prepared]);
    expect(request).toHaveBeenCalledTimes(1);
    invalidateModelCatalogCache(client);
    expect(peekModelCatalog(client, scope)).toBeUndefined();
    expect(peekModelCatalog(client, scope, { allowStale: true })?.models).toEqual([prepared]);
    expect((await loadModelCatalog(client, scope)).models).toEqual([published]);
    expect(peekModelCatalog(client, scope, { allowStale: true })?.models).toEqual([published]);
    clearModelCatalogCache(client);
    expect(peekModelCatalog(client, scope, { allowStale: true })).toBeUndefined();
    expect(isModelCatalogRetired(client, scope)).toBe(true);
    publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, { models: [published] });
    expect(isModelCatalogRetired(client, { agentId: "reader" })).toBe(false);
    clearModelCatalogCache(client, { requireSnapshot: true });
    publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, {
      models: [published],
      modelSelectionPolicy: { restricted: true, defaultModel: "example/published" },
    });
    expect(isModelCatalogRetired(client, scope)).toBe(false);
    expect(isModelCatalogRetired(client, { agentId: "reader" })).toBe(true);
  });

  it("keeps every projection and connection separate while normalizing equivalent requests", async () => {
    let generation = 0;
    const request = createGatewayRequestMock(async () => ({
      models: [{ ...prepared, id: String(++generation) }],
    }));
    const client = createTestGatewayClient(request);
    const scopes: ModelsListParams[] = [
      { agentId: "writer" },
      { agentId: "reader" },
      { agentId: "writer", sessionKey: "agent:writer:saved" },
      { agentId: "writer", authProfileId: "personal:reader:example:one" },
      { agentId: "writer", provider: "example" },
      { agentId: "writer", includeDetails: true },
      { agentId: "writer", includeProviderCapabilities: true },
      { agentId: "writer", preparedOnly: true },
      { agentId: "writer", view: "provider-config" },
    ];
    for (const [index, scope] of scopes.entries()) {
      expect((await loadModelCatalog(client, scope)).models[0]?.id).toBe(String(index + 1));
    }
    for (const [index, scope] of scopes.entries()) {
      expect((await loadModelCatalog(client, scope)).models[0]?.id).toBe(String(index + 1));
    }
    expect(
      (await loadModelCatalog(client, { view: "configured", agentId: " writer " })).models[0]?.id,
    ).toBe("1");
    expect(request).toHaveBeenCalledTimes(scopes.length);
    const otherClient = createTestGatewayClient(request);
    expect((await loadModelCatalog(otherClient, scopes[0]!)).models[0]?.id).toBe(
      String(scopes.length + 1),
    );
  });

  it("separates caller budgets while sharing the first successful projection", async () => {
    const inherited = createDeferred<ModelCatalogResult>();
    const unbounded = createDeferred<ModelCatalogResult>();
    const bounded = createDeferred<ModelCatalogResult>();
    const request = createGatewayRequestMock()
      .mockImplementationOnce(() => inherited.promise)
      .mockImplementationOnce(() => unbounded.promise)
      .mockImplementationOnce(() => bounded.promise);
    const client = createTestGatewayClient(request);
    const scope = { agentId: "writer" };
    const first = loadModelCatalog(client, scope);
    const unlimited = loadModelCatalog(client, { ...scope, timeoutMs: null });
    let earlierResults: ModelCatalogResult[] | undefined;
    void Promise.all([first, unlimited]).then((results) => {
      earlierResults = results;
    });
    const limited = loadModelCatalog(client, { ...scope, timeoutMs: 30_000 });
    const follower = loadModelCatalog(client, { ...scope, timeoutMs: 30_000 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([, params]) => params)).toEqual(
      Array.from({ length: 3 }, () => ({ view: "configured", agentId: "writer" })),
    );
    bounded.resolve({ models: [published] });
    expect(await Promise.all([limited, follower])).toEqual([
      { models: [published] },
      { models: [published] },
    ]);
    expect(await loadModelCatalog(client, { ...scope, timeoutMs: 5 })).toEqual({
      models: [published],
    });
    await expect
      .poll(() => earlierResults)
      .toEqual([{ models: [published] }, { models: [published] }]);
    inherited.resolve({ models: [prepared] });
    unbounded.resolve({ models: [prepared] });
    expect(await loadModelCatalog(client, scope)).toEqual({ models: [published] });
    expect(await loadModelCatalog(client, { ...scope, timeoutMs: null })).toEqual({
      models: [published],
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not revive an older ordinary flight after its winning cooldown snapshot expires", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const stale = createDeferred<ModelCatalogResult>();
    const first = createDeferred<ModelCatalogResult>();
    const fresh = createDeferred<ModelCatalogResult>();
    const request = createGatewayRequestMock()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => fresh.promise);
    const client = createTestGatewayClient(request);
    try {
      const old = loadModelCatalog(client, { timeoutMs: null });
      const winner = loadModelCatalog(client, { timeoutMs: 30_000 });
      first.resolve({
        models: [
          {
            ...prepared,
            available: false,
            unavailableReason: "cooldown",
            unavailableUntil: 12_000,
          },
        ],
      });
      await winner;
      clock.mockReturnValue(12_000);
      expect(peekModelCatalog(client, {})).toBeUndefined();
      const replacement = loadModelCatalog(client, { timeoutMs: null });
      expect(request).toHaveBeenCalledTimes(2);
      stale.resolve({ models: [prepared] });
      await old;
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      expect(peekModelCatalog(client, {})).toBeUndefined();
      fresh.resolve({ models: [published] });
      expect(await replacement).toEqual({ models: [published] });
      expect(peekModelCatalog(client, {})?.models).toEqual([published]);
    } finally {
      stale.resolve({ models: [prepared] });
      fresh.resolve({ models: [published] });
      clock.mockRestore();
    }
  });

  it("retries a failed request without discarding another pending budget", async () => {
    const unbounded = createDeferred<ModelCatalogResult>();
    const timeout = createDeferred<ModelCatalogResult>();
    const recovery = createDeferred<ModelCatalogResult>();
    const request = createGatewayRequestMock()
      .mockImplementationOnce(() => unbounded.promise)
      .mockImplementationOnce(() => timeout.promise)
      .mockImplementationOnce(() => recovery.promise);
    const client = createTestGatewayClient(request);
    const original = loadModelCatalog(client, { timeoutMs: null });
    const expired = loadModelCatalog(client, { timeoutMs: 30_000 });
    const reason = new Error("transport interrupted");
    const rejected = expect(expired).rejects.toBe(reason);
    timeout.reject(reason);
    await rejected;
    expect(peekModelCatalog(client, {})).toBeUndefined();
    const replacement = loadModelCatalog(client, { timeoutMs: 30_000 });
    const existing = loadModelCatalog(client, { timeoutMs: null });
    expect(request).toHaveBeenCalledTimes(3);
    recovery.resolve({ models: [published] });
    expect(await replacement).toEqual({ models: [published] });
    unbounded.resolve({ models: [prepared] });
    await Promise.all([original, existing]);
    expect(await loadModelCatalog(client, {})).toEqual({ models: [published] });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retires old projections and flights when an explicit refresh publishes", async () => {
    const stale = createDeferred<ModelCatalogResult>();
    const refresh = createDeferred<ModelCatalogResult>();
    const duringRefresh = createDeferred<ModelCatalogResult>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({ models: [prepared] })
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => refresh.promise)
      .mockImplementationOnce(() => duringRefresh.promise)
      .mockResolvedValue({ models: [published] });
    const client = createTestGatewayClient(request);
    const retainedScope = { agentId: "reader" };
    await loadModelCatalog(client, retainedScope);
    const old = loadModelCatalog(client, { agentId: "writer" });
    const replacement = loadModelCatalog(client, { view: "provider-config", refresh: true });
    const interim = loadModelCatalog(client, { agentId: "writer" });
    stale.resolve({ models: [prepared] });
    expect(await old).toEqual({ models: [prepared] });
    refresh.resolve({ models: [published] });
    expect(await replacement).toEqual({ models: [published] });
    expect(peekModelCatalog(client, retainedScope)).toBeUndefined();
    expect(peekModelCatalog(client, retainedScope, { allowStale: true })?.models).toEqual([
      prepared,
    ]);
    duringRefresh.resolve({ models: [prepared] });
    await interim;
    expect((await loadModelCatalog(client, { agentId: "writer" })).models).toEqual([published]);
    expect((await loadModelCatalog(client, { view: "provider-config" })).models).toEqual([
      published,
    ]);
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[2]?.[1]).toEqual({ view: "provider-config", refresh: true });
  });

  it.each([false, true])(
    "preserves an explicit refresh after a different-budget result (expired: %s)",
    async (expired) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      const refresh = createDeferred<ModelCatalogResult>();
      const ordinary = createDeferred<ModelCatalogResult>();
      const cooling = {
        ...prepared,
        available: false,
        unavailableReason: "cooldown" as const,
        unavailableUntil: 12_000,
      };
      const request = createGatewayRequestMock()
        .mockImplementationOnce(() => refresh.promise)
        .mockImplementationOnce(() => ordinary.promise)
        .mockResolvedValue({ models: [published] });
      const client = createTestGatewayClient(request);
      try {
        const refreshed = loadModelCatalog(client, {
          agentId: "writer",
          refresh: true,
          timeoutMs: 30_000,
        });
        const concurrent = loadModelCatalog(client, { agentId: "writer", timeoutMs: null });
        ordinary.resolve({ models: [cooling] });
        expect(await concurrent).toEqual({ models: [cooling] });
        expect(peekModelCatalog(client, { agentId: "writer" })?.models).toEqual([cooling]);
        if (expired) {
          clock.mockReturnValue(12_000);
          expect(peekModelCatalog(client, { agentId: "writer" })).toBeUndefined();
        }
        await loadModelCatalog(client, { agentId: "writer", preparedOnly: true });
        refresh.resolve({ models: [published] });
        expect(await refreshed).toEqual({ models: [published] });
        expect(await loadModelCatalog(client, { agentId: "writer", timeoutMs: 5 })).toEqual({
          models: [published],
        });
        expect(peekModelCatalog(client, { agentId: "writer", preparedOnly: true })).toBeUndefined();
        expect(request).toHaveBeenCalledTimes(3);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "keeps other projections after an explicit refresh only when discovery fails: %s",
    async (refreshFailed) => {
      const refreshing = createDeferred<ModelCatalogResult>();
      const request = createGatewayRequestMock()
        .mockImplementationOnce(() => refreshing.promise)
        .mockResolvedValue({ models: [prepared] });
      const client = createTestGatewayClient(request);
      const refresh = loadModelCatalog(client, {
        agentId: "writer",
        refresh: true,
        timeoutMs: 30_000,
      });
      for (let index = 0; index < 64; index += 1) {
        await loadModelCatalog(client, { agentId: "writer", sessionKey: `session:${index}` });
      }
      await loadModelCatalog(client, { agentId: "writer", timeoutMs: null });
      expect(peekModelCatalog(client, { agentId: "writer" })?.models).toEqual([prepared]);
      const result = { models: [published], refreshFailed };
      refreshing.resolve(result);
      expect(await refresh).toEqual(result);
      expect(peekModelCatalog(client, { agentId: "writer" }, { allowStale: true })?.models).toEqual(
        [published],
      );
      expect(
        peekModelCatalog(client, { agentId: "writer", sessionKey: "session:63" })?.models,
      ).toEqual(refreshFailed ? [prepared] : undefined);
    },
  );

  it.each(["older ordinary", "newer ordinary", "explicit refresh"] as const)(
    "Models route catalog publication keeps a concurrent %s read after partial failure",
    async (kind) => {
      const partial = createDeferred<ModelCatalogResult>();
      const complete = createDeferred<ModelCatalogResult>();
      const request = createGatewayRequestMock()
        .mockReturnValueOnce(kind === "newer ordinary" ? partial.promise : complete.promise)
        .mockReturnValueOnce(kind === "newer ordinary" ? complete.promise : partial.promise);
      const client = createTestGatewayClient(request);
      const startComplete = () =>
        loadModelCatalog(client, {
          agentId: "writer",
          timeoutMs: 30_000,
          ...(kind === "explicit refresh" ? { refresh: true } : {}),
        });
      const startPartial = () => loadModelCatalog(client, { agentId: "writer", timeoutMs: 5 });
      let partialRead: Promise<ModelCatalogResult>;
      let completeRead: Promise<ModelCatalogResult>;
      if (kind === "newer ordinary") {
        partialRead = startPartial();
        completeRead = startComplete();
      } else {
        completeRead = startComplete();
        partialRead = startPartial();
      }
      const partialResult: ModelCatalogResult = {
        models: [
          { ...prepared, available: false, unavailableReason: "cooldown", unavailableUntil: 1 },
        ],
        refreshFailed: true,
      };
      partial.resolve(partialResult);
      expect(await partialRead).toEqual(partialResult);
      expect(peekModelCatalog(client, { agentId: "writer" }, { allowStale: true })).toEqual(
        partialResult,
      );
      const follower = loadModelCatalog(client, { agentId: "writer", timeoutMs: 30_000 });
      expect(request).toHaveBeenCalledTimes(2);
      const completeResult = { models: [published] };
      complete.resolve(completeResult);
      expect(await completeRead).toEqual(completeResult);
      expect(await follower).toEqual(completeResult);
      expect(peekModelCatalog(client, { agentId: "writer" }, { allowStale: true })).toEqual(
        kind === "older ordinary" ? partialResult : completeResult,
      );
    },
  );

  it("retries partial refreshes and transport failures, but retains successful empty catalogs", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({ models: [prepared], refreshFailed: true })
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({ models: [] });
    const client = createTestGatewayClient(request);
    expect(await loadModelCatalog(client, {})).toEqual({ models: [prepared], refreshFailed: true });
    expect(peekModelCatalog(client, {})).toBeUndefined();
    expect(peekModelCatalog(client, {}, { allowStale: true })).toEqual({
      models: [prepared],
      refreshFailed: true,
    });
    await expect(loadModelCatalog(client, {})).rejects.toThrow("transport closed");
    expect(peekModelCatalog(client, {}, { allowStale: true })?.models).toEqual([prepared]);
    expect(await loadModelCatalog(client, {})).toEqual({ models: [] });
    expect(await loadModelCatalog(client, {})).toEqual({ models: [] });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null, 30_000])(
    "shares timeout %s without letting one consumer cancel another",
    async (timeoutMs) => {
      const pending = createDeferred<ModelCatalogResult>();
      const first = new AbortController();
      const second = new AbortController();
      const request = createGatewayRequestMock(() => pending.promise);
      const client = createTestGatewayClient(request);
      const retired = loadModelCatalog(client, {
        agentId: "writer",
        signal: first.signal,
        timeoutMs,
      });
      const active = loadModelCatalog(client, {
        agentId: "writer",
        signal: second.signal,
        timeoutMs,
      });
      const reason = new DOMException("Page retired", "AbortError");
      first.abort(reason);
      await expect(retired).rejects.toBe(reason);
      pending.resolve({ models: [published] });
      expect(await active).toEqual({ models: [published] });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("retires the last consumer immediately but waits for transport before replacing its flight", async () => {
    const stale = createDeferred<ModelCatalogResult>();
    const request = createGatewayRequestMock()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ models: [published] });
    const client = createTestGatewayClient(request);
    const controller = new AbortController();
    const retired = loadModelCatalog(client, { signal: controller.signal });
    const rejected = expect(retired).rejects.toHaveProperty("name", "AbortError");
    controller.abort();
    await rejected;
    const replacement = loadModelCatalog(client, {});
    expect(request).toHaveBeenCalledOnce();
    stale.resolve({ models: [prepared] });
    expect(await replacement).toEqual({ models: [published] });
    expect(request).toHaveBeenCalledTimes(2);
    expect(await loadModelCatalog(client, {})).toEqual({ models: [published] });
  });

  it("invalidates saved-session projections without discarding other sessions or draft accounts", async () => {
    const request = createGatewayRequestMock(async () => ({ models: [published] }));
    const client = createTestGatewayClient(request);
    const scopes = [
      { agentId: "writer", sessionKey: "global" },
      { agentId: "reader", sessionKey: "global" },
      { agentId: "writer", sessionKey: "other" },
      { agentId: "writer", authProfileId: "personal:writer:example:one" },
    ];
    const implicitAgentScope = { sessionKey: "global" };
    await Promise.all(
      [...scopes, implicitAgentScope].map((scope) => loadModelCatalog(client, scope)),
    );
    invalidateModelCatalogCache(client, scopes[0]);
    expect(peekModelCatalog(client, implicitAgentScope)).toBeUndefined();
    expect(peekModelCatalog(client, scopes[0]!)).toBeUndefined();
    for (const scope of scopes.slice(1)) {
      expect(peekModelCatalog(client, scope)?.models).toEqual([published]);
    }
    await loadModelCatalog(client, scopes[0]!);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("bounds retained session snapshots while keeping recently used entries warm", async () => {
    const request = createGatewayRequestMock(async () => ({ models: [published] }));
    const client = createTestGatewayClient(request);
    for (let index = 0; index < 64; index += 1) {
      await loadModelCatalog(client, { sessionKey: `session:${index}` });
    }
    await loadModelCatalog(client, { sessionKey: "session:0" });
    await loadModelCatalog(client, { sessionKey: "session:64" });
    expect(peekModelCatalog(client, { sessionKey: "session:0" })?.models).toEqual([published]);
    expect(peekModelCatalog(client, { sessionKey: "session:1" })).toBeUndefined();

    const cold = createDeferred<ModelCatalogResult>();
    request.mockImplementation(() => cold.promise);
    const scopes = Array.from({ length: 65 }, (_, index) => ({ sessionKey: `cold:${index}` }));
    const concurrent = Promise.all(scopes.map((scope) => loadModelCatalog(client, scope)));
    cold.resolve({ models: [published] });
    await concurrent;
    expect(scopes.filter((scope) => peekModelCatalog(client, scope))).toHaveLength(64);
    const retired = createDeferred<ModelCatalogResult>();
    request.mockImplementation(() => retired.promise);
    const retiring = Promise.all(
      scopes.map((_, index) => loadModelCatalog(client, { sessionKey: `retired:${index}` })),
    );
    invalidateModelCatalogCache(client);
    expect(modelCatalogCache.get(client)?.entries.size).toBeLessThanOrEqual(64);
    retired.resolve({ models: [prepared] });
    await retiring;
    expect(modelCatalogCache.get(client)?.entries.size).toBeLessThanOrEqual(64);
  });

  it("rejects an already retired request before transport or cached publication", async () => {
    const request = createGatewayRequestMock();
    const controller = new AbortController();
    const reason = new DOMException("Page retired", "AbortError");
    controller.abort(reason);
    await expect(
      loadModelCatalog(createTestGatewayClient(request), { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });
});
