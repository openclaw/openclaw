import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { invalidateModelCatalogCache } from "./model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "./model-catalog-store.ts";

const prepared = { id: "prepared", name: "Prepared", provider: "example" };
const published = { id: "published", name: "Published", provider: "example" };

describe("model catalog display cache", () => {
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
    expect(peekModelCatalog(client, scope)).toBeUndefined();
    expect((await loadModelCatalog(client, scope)).models).toEqual([prepared]);
    expect(peekModelCatalog(client, scope)?.models).toEqual([prepared]);
    expect((await loadModelCatalog(client, scope)).models).toEqual([prepared]);
    expect(request).toHaveBeenCalledTimes(1);
    invalidateModelCatalogCache(client);
    expect(peekModelCatalog(client, scope)).toBeUndefined();
    expect((await loadModelCatalog(client, scope)).models).toEqual([published]);
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

  it("separates transport budgets while sharing the first successful projection", async () => {
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
    const limited = loadModelCatalog(client, { ...scope, timeoutMs: 30_000 });
    const follower = loadModelCatalog(client, { ...scope, timeoutMs: 30_000 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([, params, options]) => ({ params, options }))).toEqual([
      { params: { view: "configured", agentId: "writer" }, options: undefined },
      { params: { view: "configured", agentId: "writer" }, options: { timeoutMs: null } },
      { params: { view: "configured", agentId: "writer" }, options: { timeoutMs: 30_000 } },
    ]);
    bounded.resolve({ models: [published] });
    expect(await Promise.all([limited, follower])).toEqual([
      { models: [published] },
      { models: [published] },
    ]);
    expect(await loadModelCatalog(client, { ...scope, timeoutMs: 5 })).toEqual({
      models: [published],
    });
    inherited.resolve({ models: [prepared] });
    unbounded.resolve({ models: [prepared] });
    await Promise.all([first, unlimited]);
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
      expect(request).toHaveBeenCalledTimes(3);
      stale.resolve({ models: [prepared] });
      await old;
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

  it("retries a Gateway-timed-out budget without discarding another pending budget", async () => {
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
    const reason = new GatewayProtocolRequestTimeoutError({
      method: "models.list",
      timeoutMs: 30_000,
      requestSent: true,
    });
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
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => refresh.promise)
      .mockImplementationOnce(() => duringRefresh.promise)
      .mockResolvedValue({ models: [published] });
    const client = createTestGatewayClient(request);
    const old = loadModelCatalog(client, { agentId: "writer" });
    const replacement = loadModelCatalog(client, { view: "provider-config", refresh: true });
    const interim = loadModelCatalog(client, { agentId: "writer" });
    stale.resolve({ models: [prepared] });
    expect(await old).toEqual({ models: [prepared] });
    refresh.resolve({ models: [published] });
    expect(await replacement).toEqual({ models: [published] });
    duringRefresh.resolve({ models: [prepared] });
    await interim;
    expect((await loadModelCatalog(client, { agentId: "writer" })).models).toEqual([published]);
    expect((await loadModelCatalog(client, { view: "provider-config" })).models).toEqual([
      published,
    ]);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[1]?.[1]).toEqual({ view: "provider-config", refresh: true });
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

  it("keeps an explicit refresh authoritative while other projections fill the cache", async () => {
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
    refreshing.resolve({ models: [published] });
    expect(await refresh).toEqual({ models: [published] });
    expect(peekModelCatalog(client, { agentId: "writer" })?.models).toEqual([published]);
  });

  it("retries partial refreshes and transport failures, but retains successful empty catalogs", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({ models: [prepared], refreshFailed: true })
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({ models: [] });
    const client = createTestGatewayClient(request);
    expect(await loadModelCatalog(client, {})).toEqual({ models: [prepared], refreshFailed: true });
    expect(peekModelCatalog(client, {})).toBeUndefined();
    await expect(loadModelCatalog(client, {})).rejects.toThrow("transport closed");
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
      expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);
      pending.resolve({ models: [published] });
      expect(await active).toEqual({ models: [published] });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("replaces a flight immediately when its last consumer retires", async () => {
    const stale = createDeferred<ModelCatalogResult>();
    const request = createGatewayRequestMock()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ models: [published] });
    const client = createTestGatewayClient(request);
    const controller = new AbortController();
    const retired = loadModelCatalog(client, { signal: controller.signal });
    const rejected = expect(retired).rejects.toHaveProperty("name", "AbortError");
    controller.abort();
    expect(await loadModelCatalog(client, {})).toEqual({ models: [published] });
    await rejected;
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    stale.resolve({ models: [prepared] });
    await stale.promise;
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
