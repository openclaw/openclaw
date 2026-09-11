import { describe, expect, it } from "vitest";
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

  it("shares a flight without letting one consumer cancel another", async () => {
    const pending = createDeferred<ModelCatalogResult>();
    const first = new AbortController();
    const second = new AbortController();
    const request = createGatewayRequestMock(() => pending.promise);
    const client = createTestGatewayClient(request);
    const retired = loadModelCatalog(client, { agentId: "writer", signal: first.signal });
    const active = loadModelCatalog(client, { agentId: "writer", signal: second.signal });
    const reason = new DOMException("Page retired", "AbortError");
    first.abort(reason);
    await expect(retired).rejects.toBe(reason);
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);
    pending.resolve({ models: [published] });
    expect(await active).toEqual({ models: [published] });
    expect(request).toHaveBeenCalledTimes(1);
  });

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
