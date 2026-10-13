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
  subscribeModelCatalogCache,
} from "./model-catalog-store.ts";

const prepared = { id: "prepared", name: "Prepared", provider: "example" };
const published = { id: "published", name: "Published", provider: "example" };

describe("model catalog display cache", () => {
  it("keeps replacement observers when a retired subscription is disposed again", () => {
    const client = createTestGatewayClient(createGatewayRequestMock());
    const retired = vi.fn();
    const active = vi.fn();
    const unsubscribeRetired = subscribeModelCatalogCache(client, retired);
    unsubscribeRetired();
    const unsubscribeActive = subscribeModelCatalogCache(client, active);
    try {
      unsubscribeRetired();
      publishModelCatalogResult(beginModelCatalogRead(client, {}), {}, { models: [published] });
      expect(active).toHaveBeenCalledWith({ type: "published" });
      expect(retired).not.toHaveBeenCalled();
      unsubscribeActive();
      active.mockClear();
      invalidateModelCatalogCache(client);
      expect(active).not.toHaveBeenCalled();
    } finally {
      unsubscribeActive();
    }
  });

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
